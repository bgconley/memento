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

const DEFAULT_BATCH_SIZE = 64;
const DEFAULT_CONCURRENCY = 2;

type BatchResult = {
  index: number;
  chunks: ChunkRow[];
  vectors: number[][];
  dimensions: number;
};

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

export async function reindexProfile(event: OutboxEvent, client: PoolClient): Promise<void> {
  const payload = parsePayload(event.payload);
  const profileId = readString(payload.embedding_profile_id);

  if (!profileId) {
    throw new Error("REINDEX_PROFILE missing embedding_profile_id");
  }

  const profile = await loadEmbeddingProfile(client, event.project_id, profileId);
  const embedder = createEmbedder(profile);

  const batchSize = getEnvNumber("EMBED_BATCH_SIZE", DEFAULT_BATCH_SIZE, 1, 512);
  const concurrency = getEnvNumber("EMBED_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 8);
  const pageSize = Math.max(batchSize * Math.max(concurrency, 1), batchSize);

  let lastId: string | null = null;
  let processed = 0;

  while (true) {
    const result = await client.query(
      `SELECT id, chunk_text
       FROM memory_chunks
       WHERE project_id = $1
         AND ($2::uuid IS NULL OR id > $2)
       ORDER BY id ASC
       LIMIT $3`,
      [event.project_id, lastId, pageSize]
    );

    const chunks: ChunkRow[] = result.rows;
    if (chunks.length === 0) {
      if (processed === 0) {
        await client.query(
          "DELETE FROM chunk_embeddings WHERE project_id = $1 AND embedding_profile_id = $2",
          [event.project_id, profile.id]
        );
      }
      break;
    }

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

    processed += chunks.length;
    lastId = chunks[chunks.length - 1].id;
  }
}
