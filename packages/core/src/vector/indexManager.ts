import crypto from "node:crypto";
import type { Pool } from "pg";
import { ValidationError } from "../db";

export type EnsureIndexResult = {
  indexName: string;
  created: boolean;
  concurrently: boolean;
};

type HnswConfig = {
  m?: number;
  ef_construction?: number;
};

const DISTANCE_OPS: Record<string, string> = {
  cosine: "vector_cosine_ops",
  l2: "vector_l2_ops",
  ip: "vector_ip_ops",
};

function shortHash(input: string, length = 10): string {
  return crypto.createHash("sha1").update(input).digest("hex").slice(0, length);
}

export function buildProfileIndexName(profileId: string): string {
  const suffix = shortHash(profileId);
  return `chunk_embeddings_hnsw_${suffix}`;
}

export async function ensureProfileIndex(
  pool: Pool,
  profileId: string,
  dims: number,
  distance: string,
  options?: { concurrently?: boolean; hnsw?: HnswConfig }
): Promise<EnsureIndexResult> {
  if (!profileId) {
    throw new ValidationError("profile_id is required");
  }
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new ValidationError("dims must be a positive integer");
  }

  const indexName = buildProfileIndexName(profileId);
  const opClass = DISTANCE_OPS[distance] ?? DISTANCE_OPS.cosine;
  const concurrently = options?.concurrently ?? true;
  const hnsw = normalizeHnswConfig(options?.hnsw);

  const exists = await pool.query(
    "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1",
    [indexName]
  );

  if (exists.rowCount && exists.rowCount > 0) {
    const indexDef = String(exists.rows[0]?.indexdef ?? "");
    const hasDims = indexDef.includes(`vector(${dims})`);
    const hasOps = indexDef.includes(opClass);
    const hasPredicate = indexDef.includes(`embedding_profile_id = '${profileId}'`);
    const hasHnsw =
      !hnsw ||
      ((hnsw.m ? hasIndexParam(indexDef, "m", hnsw.m) : true) &&
        (hnsw.ef_construction ? hasIndexParam(indexDef, "ef_construction", hnsw.ef_construction) : true));

    if (hasDims && hasOps && hasPredicate && hasHnsw) {
      return { indexName, created: false, concurrently };
    }

    const dropSql = `DROP INDEX ${concurrently ? "CONCURRENTLY " : ""}IF EXISTS ${indexName}`;
    await pool.query(dropSql);
  }

  const escapedProfileId = `'${profileId.replace(/'/g, "''")}'`;
  const withClause = hnsw ? ` WITH (${formatHnswParams(hnsw)})` : "";
  const createSql = `CREATE INDEX ${concurrently ? "CONCURRENTLY " : ""}IF NOT EXISTS ${indexName}
    ON chunk_embeddings USING hnsw ((embedding::vector(${dims})) ${opClass})${withClause}
    WHERE embedding_profile_id = ${escapedProfileId}`;

  await pool.query(createSql);

  return { indexName, created: true, concurrently };
}

function normalizeHnswConfig(hnsw?: HnswConfig): HnswConfig | null {
  if (!hnsw) return null;
  const m = toPositiveInt(hnsw.m);
  const efConstruction = toPositiveInt(hnsw.ef_construction);
  if (!m && !efConstruction) return null;
  return { m: m ?? undefined, ef_construction: efConstruction ?? undefined };
}

function toPositiveInt(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  const intValue = Math.floor(parsed);
  return intValue > 0 ? intValue : null;
}

function formatHnswParams(hnsw: HnswConfig): string {
  const params: string[] = [];
  if (hnsw.m) params.push(`m = ${hnsw.m}`);
  if (hnsw.ef_construction) params.push(`ef_construction = ${hnsw.ef_construction}`);
  return params.join(", ");
}

function hasIndexParam(indexDef: string, name: string, value: number): boolean {
  const patterns = [`${name}=${value}`, `${name} = ${value}`];
  return patterns.some((pattern) => indexDef.includes(pattern));
}
