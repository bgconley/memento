import type { Pool } from "pg";
import {
  FakeEmbedder,
  JinaEmbedder,
  OpenAICompatEmbedder,
  VoyageEmbedder,
  type Embedder,
} from "@memento/clients";
import { getActiveEmbeddingProfile, type EmbeddingProfileRow } from "../repos/embeddingProfiles";
import { appendItemFilters, type SearchFilters, type SemanticMatch } from "./filters";

export type SemanticSearchOptions = {
  top_k?: number;
  max_chunk_chars?: number;
  ef_search?: number;
};

export type SemanticSearchResult = {
  matches: SemanticMatch[];
  profile_id?: string;
  reason?: string;
};

const DEFAULT_TOP_K = 40;
const DEFAULT_MAX_CHUNK_CHARS = 300;
const DEFAULT_EF_SEARCH_MIN = 40;
const DEFAULT_EF_SEARCH_FACTOR = 2;
const DEFAULT_EF_SEARCH_MAX = 400;
const DEFAULT_CANDIDATE_MULTIPLIER = 4;
const FILTERED_CANDIDATE_MULTIPLIER = 8;

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string }> = {
  voyage: { baseUrl: "https://api.voyageai.com" },
  jina: { baseUrl: "https://api.jina.ai" },
  openai_compat: { baseUrl: "http://localhost:8080/v1" },
};

function readBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.toLowerCase() === "true" || value === "1";
  }
  return false;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function resolveBaseUrl(provider: string, config: Record<string, unknown>): string {
  const fromConfig = readString(config.base_url);
  const fromEnv = readString(process.env.EMBEDDER_BASE_URL);
  return fromConfig ?? fromEnv ?? PROVIDER_DEFAULTS[provider]?.baseUrl ?? "";
}

function resolveApiKey(config: Record<string, unknown>): string | undefined {
  const fromEnv = readString(process.env.EMBEDDER_API_KEY);
  const fromConfig = readString(config.api_key);
  return fromEnv ?? fromConfig;
}

function createEmbedder(profile: EmbeddingProfileRow): Embedder | null {
  const config = profile.provider_config ?? {};

  if (readBoolean(process.env.EMBEDDER_USE_FAKE) || readBoolean(config.use_fake)) {
    return new FakeEmbedder({ dims: profile.dims, model: profile.model, provider: profile.provider });
  }

  const baseUrl = resolveBaseUrl(profile.provider, config);
  if (!baseUrl) return null;

  const apiKey = resolveApiKey(config);

  if (profile.provider === "voyage") {
    return new VoyageEmbedder({ baseUrl, apiKey, model: profile.model, dims: profile.dims });
  }
  if (profile.provider === "jina") {
    const lateChunking = readBoolean(config.late_chunking);
    return new JinaEmbedder({ baseUrl, apiKey, model: profile.model, dims: profile.dims, lateChunking });
  }
  if (profile.provider === "openai_compat") {
    return new OpenAICompatEmbedder({ baseUrl, apiKey, model: profile.model, dims: profile.dims });
  }

  return null;
}

function distanceOperator(distance: string): string {
  if (distance === "l2") return "<->";
  if (distance === "ip") return "<#>";
  return "<=>";
}

function distanceToScore(distance: number, metric: string): number {
  if (metric === "cosine") return 1 - distance;
  return -distance;
}

function resolveEfSearch(profile: EmbeddingProfileRow, topK: number, override?: number): number {
  const queryConfig = (profile.provider_config as Record<string, unknown> | undefined)?.query;
  const config =
    queryConfig && typeof queryConfig === "object" ? (queryConfig as Record<string, unknown>) : {};
  const minValue = readNumber(config.ef_search_min) ?? DEFAULT_EF_SEARCH_MIN;
  const factor = readNumber(config.ef_search_factor) ?? DEFAULT_EF_SEARCH_FACTOR;
  const rawMax = readNumber(config.ef_search_max) ?? DEFAULT_EF_SEARCH_MAX;
  const maxValue = Math.max(rawMax, minValue);

  const base = override ?? Math.max(minValue, topK, Math.ceil(topK * factor));
  const clamped = Math.min(Math.max(base, minValue), maxValue);
  return Math.max(clamped, topK);
}

function hasFilters(filters: SearchFilters | undefined): boolean {
  if (!filters) return false;
  return Boolean(
    filters.kinds?.length ||
      filters.scopes?.length ||
      filters.pinned_only ||
      filters.canonical_only ||
      filters.doc_classes?.length ||
      filters.tags_all?.length ||
      filters.tags_any?.length ||
      filters.created_after ||
      filters.item_ids?.length
  );
}

export async function semanticSearch(
  pool: Pool,
  input: {
    project_id: string;
    query: string;
    filters?: SearchFilters;
    options?: SemanticSearchOptions;
  }
): Promise<SemanticSearchResult> {
  const { project_id, query, filters, options } = input;
  const topK = options?.top_k ?? DEFAULT_TOP_K;
  const maxChars = options?.max_chunk_chars ?? DEFAULT_MAX_CHUNK_CHARS;

  const profile = await getActiveEmbeddingProfile(pool, project_id);
  if (!profile) {
    return { matches: [], reason: "no_active_profile" };
  }

  const embedder = createEmbedder(profile);
  if (!embedder) {
    return { matches: [], profile_id: profile.id, reason: "embedder_not_configured" };
  }

  const embedding = await embedder.embed({ texts: [query], inputType: "query" });
  const vector = embedding.vectors[0];
  if (!vector || vector.length === 0) {
    return { matches: [], profile_id: profile.id, reason: "empty_embedding" };
  }

  if (embedding.dimensions && embedding.dimensions !== profile.dims) {
    throw new Error(`Embedding dimension mismatch: expected ${profile.dims}, got ${embedding.dimensions}`);
  }

  const vectorLiteral = JSON.stringify(vector);
  const operator = distanceOperator(profile.distance);
  const efSearch = resolveEfSearch(profile, topK, options?.ef_search);
  const candidateMultiplier = hasFilters(filters)
    ? FILTERED_CANDIDATE_MULTIPLIER
    : DEFAULT_CANDIDATE_MULTIPLIER;
  const candidateLimit = Math.max(topK * candidateMultiplier, topK);

  const distanceExpr = `ce.embedding::vector(${profile.dims}) ${operator} $1::vector(${profile.dims})`;
  const candidateSql = `
    SELECT ce.chunk_id, ${distanceExpr} AS distance
    FROM chunk_embeddings ce
    WHERE ce.embedding_profile_id = $2
    ORDER BY ${distanceExpr} ASC
    LIMIT $3
  `;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const efSearchValue = Math.max(1, Math.floor(efSearch));
    await client.query(`SET LOCAL hnsw.ef_search = ${efSearchValue}`);
    const candidateResult = await client.query(candidateSql, [
      vectorLiteral,
      profile.id,
      candidateLimit,
    ]);
    await client.query("COMMIT");

    if (candidateResult.rows.length === 0) {
      return { matches: [], profile_id: profile.id };
    }

    const chunkIds = candidateResult.rows.map((row) => row.chunk_id);
    const distances = candidateResult.rows.map((row) => Number(row.distance));

    const values: unknown[] = [chunkIds, distances];

    values.push(project_id);
    const projectParam = `$${values.length}`;
    const where = [
      `mc.project_id = ${projectParam}`,
      `mi.project_id = ${projectParam}`,
      "mi.status = 'active'",
    ];

    where.push(...appendItemFilters(filters, values, "mi"));

    values.push(maxChars);
    const maxParam = `$${values.length}`;
    values.push(topK);
    const limitParam = `$${values.length}`;

    const joinSql = `
      SELECT
        mc.id AS chunk_id,
        mv.id AS version_id,
        mv.version_num,
        mi.id AS item_id,
        mi.title,
        mi.kind,
        mi.scope,
        mi.canonical_key,
        mi.pinned,
        mi.tags,
        mc.heading_path,
        mc.section_anchor,
        LEFT(mc.chunk_text, ${maxParam}) AS excerpt,
        t.distance AS distance
      FROM unnest($1::uuid[], $2::double precision[]) AS t(chunk_id, distance)
      JOIN memory_chunks mc ON mc.id = t.chunk_id
      JOIN memory_versions mv ON mv.id = mc.version_id
      JOIN memory_items mi ON mi.id = mv.item_id
      WHERE ${where.join(" AND ")}
      ORDER BY t.distance ASC
      LIMIT ${limitParam}
    `;

    const result = await client.query(joinSql, values);
    const matches = result.rows.map((row) => {
      const distance = Number(row.distance ?? 0);
      return {
        chunk_id: row.chunk_id,
        version_id: row.version_id,
        version_num: Number(row.version_num),
        item_id: row.item_id,
        title: row.title,
        kind: row.kind,
        scope: row.scope,
        canonical_key: row.canonical_key,
        pinned: row.pinned,
        tags: row.tags ?? [],
        heading_path: row.heading_path ?? [],
        section_anchor: row.section_anchor,
        excerpt: row.excerpt ?? "",
        distance,
        score: distanceToScore(distance, profile.distance),
      } as SemanticMatch;
    });

    return { matches, profile_id: profile.id };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors when no transaction is active
    }
    throw err;
  } finally {
    client.release();
  }
}
