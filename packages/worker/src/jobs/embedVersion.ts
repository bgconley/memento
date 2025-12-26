import type { Pool } from "pg";
import { createLogger } from "@memento/shared";
import type { OutboxEvent } from "../outboxPoller";
import {
  buildBatches,
  createEmbedder,
  getEnvNumber,
  insertEmbeddings,
  loadEmbeddingProfile,
  runWithConcurrency,
  type ChunkRow,
} from "./embedderUtils";
import { parsePayload, requireStringField } from "./payload";

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_CONTEXTUAL_MAX_CHARS = 50000;
const DEFAULT_CONTEXTUAL_MAX_CHUNKS = 256;

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.toLowerCase() === "true" || value === "1";
  }
  return false;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
type BatchResult = {
  index: number;
  chunks: ChunkRow[];
  vectors: number[][];
  dimensions: number;
};

export async function embedVersion(event: OutboxEvent, pool: Pool): Promise<void> {
  const logger = createLogger({ component: "worker", job: "embedVersion", event_id: event.id });
  const payload = parsePayload(event.payload);
  const versionId = requireStringField(payload, "version_id", "EMBED_VERSION");

  const versionResult = await pool.query(
    `SELECT mv.id,
            mv.project_id,
            mv.item_id,
            mi.doc_class,
            mi.canonical_key,
            (cd.id IS NOT NULL) AS is_canonical
     FROM memory_versions mv
     JOIN memory_items mi ON mv.item_id = mi.id
     LEFT JOIN canonical_docs cd
       ON cd.item_id = mv.item_id AND cd.project_id = mv.project_id
     WHERE mv.id = $1`,
    [versionId]
  );
  const version = versionResult.rows[0];
  if (!version) {
    throw new Error(`Version not found: ${versionId}`);
  }

  const profileId = readString(payload.embedding_profile_id);
  const profile = await loadEmbeddingProfile(pool, version.project_id, profileId);

  const chunkResult = await pool.query(
    `SELECT id, chunk_text
     FROM memory_chunks
     WHERE version_id = $1
     ORDER BY chunk_index ASC`,
    [versionId]
  );

  const chunks: ChunkRow[] = chunkResult.rows;

  if (chunks.length === 0) {
    await pool.query(
      `DELETE FROM chunk_embeddings ce
       USING memory_chunks mc
       WHERE ce.chunk_id = mc.id
         AND mc.version_id = $1
         AND ce.embedding_profile_id = $2`,
      [versionId, profile.id]
    );
    return;
  }

  const embedder = createEmbedder(profile);

  const canonicalDocClasses = new Set(["app_spec", "feature_spec", "implementation_plan"]);
  const isCanonical = Boolean(version.is_canonical) || Boolean(version.canonical_key);
  const docClass = typeof version.doc_class === "string" ? version.doc_class : null;
  const providerConfig = profile.provider_config ?? {};
  const contextualEnabled =
    profile.provider === "jina"
      ? readBoolean((providerConfig as Record<string, unknown>).late_chunking)
      : true;
  if (
    profile.provider === "jina" &&
    isCanonical &&
    docClass !== null &&
    canonicalDocClasses.has(docClass) &&
    !contextualEnabled
  ) {
    logger.warn("contextual.disabled_late_chunking", { doc_class: docClass });
  }
  const shouldUseContextual =
    contextualEnabled &&
    isCanonical &&
    docClass !== null &&
    canonicalDocClasses.has(docClass) &&
    typeof embedder.embedDocumentChunksContextual === "function";

  const batchSize = getEnvNumber("EMBED_BATCH_SIZE", DEFAULT_BATCH_SIZE, 1, 256);
  const concurrency = getEnvNumber("EMBED_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 8);
  const batches = buildBatches(chunks, batchSize);

  if (shouldUseContextual) {
    const totalChars = chunks.reduce((sum, chunk) => sum + chunk.chunk_text.length, 0);
    const contextualMaxChars =
      readNumber((providerConfig as Record<string, unknown>).contextual_max_chars) ??
      getEnvNumber("CONTEXTUAL_MAX_CHARS", DEFAULT_CONTEXTUAL_MAX_CHARS, 1000, 200000);
    const contextualMaxChunks =
      readNumber((providerConfig as Record<string, unknown>).contextual_max_chunks) ??
      getEnvNumber("CONTEXTUAL_MAX_CHUNKS", DEFAULT_CONTEXTUAL_MAX_CHUNKS, 1, 2048);
    const contextualStrict =
      readBoolean(process.env.CONTEXTUAL_STRICT) ||
      readBoolean((providerConfig as Record<string, unknown>).contextual_strict);

    if (totalChars > contextualMaxChars || chunks.length > contextualMaxChunks) {
      logger.warn("contextual.skip_oversize", {
        total_chars: totalChars,
        chunk_count: chunks.length,
        max_chars: contextualMaxChars,
        max_chunks: contextualMaxChunks,
      });
    } else {
      try {
        const response = await embedder.embedDocumentChunksContextual?.(
          chunks.map((chunk) => chunk.chunk_text)
        );
        if (!response) {
          throw new Error("Contextual embedder response missing");
        }

        if (response.dimensions && response.dimensions !== profile.dims) {
          throw new Error(
            `Embedding dimension mismatch: expected ${profile.dims}, got ${response.dimensions}`
          );
        }

        if (response.vectors.length !== chunks.length) {
          throw new Error("Embedding response size mismatch");
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await insertEmbeddings(client, profile.id, chunks, response.vectors);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
        return;
      } catch (err) {
        if (contextualStrict) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.warn("contextual.fallback", { error: message });
      }
    }
  }

  const batchResults = await runWithConcurrency(
    batches.map((batch) => async () => {
      const response = await embedder.embed({
        texts: batch.chunks.map((chunk) => chunk.chunk_text),
        inputType: "passage",
      });

      if (response.dimensions && response.dimensions !== profile.dims) {
        throw new Error(
          `Embedding dimension mismatch: expected ${profile.dims}, got ${response.dimensions}`
        );
      }

      if (response.vectors.length !== batch.chunks.length) {
        throw new Error("Embedding response size mismatch");
      }

      return {
        index: batch.index,
        chunks: batch.chunks,
        vectors: response.vectors,
        dimensions: response.dimensions,
      } as BatchResult;
    }),
    concurrency
  );

  batchResults.sort((a, b) => a.index - b.index);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const batch of batchResults) {
      await insertEmbeddings(client, profile.id, batch.chunks, batch.vectors);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
