import type { Pool, PoolClient } from "pg";
import { createEmbedderFromProfile, type Embedder } from "@memento/clients";

export type EmbeddingProfileRow = {
  id: string;
  project_id: string;
  provider: string;
  model: string;
  dims: number;
  distance: string;
  provider_config: Record<string, unknown>;
};

export type ChunkRow = {
  id: string;
  chunk_text: string;
};

export type Batch = {
  index: number;
  chunks: ChunkRow[];
};

type Queryable = Pick<PoolClient, "query"> | Pick<Pool, "query">;

function readNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function getEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const value = readNumber(process.env[name]);
  if (value === undefined) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function createEmbedder(profile: EmbeddingProfileRow): Embedder {
  return createEmbedderFromProfile(profile);
}

export function buildBatches(chunks: ChunkRow[], batchSize: number): Batch[] {
  const batches: Batch[] = [];
  let index = 0;
  for (let i = 0; i < chunks.length; i += batchSize) {
    batches.push({ index, chunks: chunks.slice(i, i + batchSize) });
    index += 1;
  }
  return batches;
}

export async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  const queue = tasks.map((_, index) => index);

  const workers = new Array(Math.max(limit, 1)).fill(0).map(async () => {
    while (true) {
      const current = queue.pop();
      if (current === undefined) return;
      results[current] = await tasks[current]();
    }
  });

  await Promise.all(workers);
  return results;
}

function toVectorLiteral(vector: number[]): string {
  return JSON.stringify(vector);
}

export async function loadEmbeddingProfile(
  client: Queryable,
  projectId: string,
  embeddingProfileId?: string
): Promise<EmbeddingProfileRow> {
  if (embeddingProfileId) {
    const result = await client.query(
      `SELECT id, project_id, provider, model, dims, distance, provider_config
       FROM embedding_profiles
       WHERE id = $1 AND project_id = $2`,
      [embeddingProfileId, projectId]
    );
    if (result.rows[0]) return result.rows[0];
    throw new Error(`Embedding profile not found: ${embeddingProfileId}`);
  }

  const active = await client.query(
    `SELECT id, project_id, provider, model, dims, distance, provider_config
     FROM embedding_profiles
     WHERE project_id = $1 AND is_active = true
     ORDER BY created_at DESC
     LIMIT 1`,
    [projectId]
  );

  if (!active.rows[0]) {
    throw new Error("No active embedding profile for project");
  }

  return active.rows[0];
}

export async function insertEmbeddings(
  client: Queryable,
  profileId: string,
  chunks: ChunkRow[],
  vectors: number[][]
): Promise<void> {
  const values: Array<unknown> = [];
  const placeholders: string[] = [];
  let index = 1;

  for (let i = 0; i < chunks.length; i += 1) {
    placeholders.push(`($${index}, $${index + 1}, $${index + 2}::vector)`);
    values.push(chunks[i].id, profileId, toVectorLiteral(vectors[i]));
    index += 3;
  }

  await client.query(
    `INSERT INTO chunk_embeddings (chunk_id, embedding_profile_id, embedding)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (chunk_id, embedding_profile_id)
     DO UPDATE SET embedding = EXCLUDED.embedding`,
    values
  );
}
