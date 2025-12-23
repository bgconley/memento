import type { PoolClient } from "pg";
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

const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_CONCURRENCY = 2;

function parsePayload(payload: unknown): Record<string, unknown> {
  if (typeof payload === "string") {
    return JSON.parse(payload) as Record<string, unknown>;
  }
  if (payload && typeof payload === "object") {
    return payload as Record<string, unknown>;
  }
  return {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
type BatchResult = {
  index: number;
  chunks: ChunkRow[];
  vectors: number[][];
  dimensions: number;
};

export async function embedVersion(event: OutboxEvent, client: PoolClient): Promise<void> {
  const payload = parsePayload(event.payload);
  const versionId = payload.version_id as string | undefined;

  if (!versionId) {
    throw new Error("EMBED_VERSION missing version_id");
  }

  const versionResult = await client.query(
    "SELECT id, project_id FROM memory_versions WHERE id = $1",
    [versionId]
  );
  const version = versionResult.rows[0];
  if (!version) {
    throw new Error(`Version not found: ${versionId}`);
  }

  const profileId = readString(payload.embedding_profile_id);
  const profile = await loadEmbeddingProfile(client, version.project_id, profileId);

  const chunkResult = await client.query(
    `SELECT id, chunk_text
     FROM memory_chunks
     WHERE version_id = $1
     ORDER BY chunk_index ASC`,
    [versionId]
  );

  const chunks: ChunkRow[] = chunkResult.rows;

  if (chunks.length === 0) {
    await client.query(
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

  const batchSize = getEnvNumber("EMBED_BATCH_SIZE", DEFAULT_BATCH_SIZE, 1, 256);
  const concurrency = getEnvNumber("EMBED_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 8);
  const batches = buildBatches(chunks, batchSize);

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

  for (const batch of batchResults) {
    await insertEmbeddings(client, profile.id, batch.chunks, batch.vectors);
  }
}
