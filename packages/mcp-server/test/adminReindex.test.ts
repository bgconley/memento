import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHandlers } from "../src/handlers";
import { createRequestContext } from "../src/context";
import { createPool } from "@memento/core";
import { createJobHandlers } from "../../worker/src/outboxPoller";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for admin reindex tests");
}

process.env.EMBEDDER_USE_FAKE = "1";

const pool = createPool({ connectionString: DATABASE_URL });

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function processNextOutboxEvent(projectId: string): Promise<boolean> {
  const client = await pool.connect();
  const handlers = createJobHandlers();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT id, project_id, event_type, payload, created_at, attempts
       FROM outbox_events
       WHERE processed_at IS NULL
         AND project_id = $1
         AND (processing_expires_at IS NULL OR processing_expires_at < now())
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [projectId]
    );

    const row = result.rows[0];
    if (!row) {
      await client.query("COMMIT");
      return false;
    }

    await client.query(
      `UPDATE outbox_events
       SET processing_started_at = now(),
           processing_expires_at = now() + interval '300 seconds',
           attempts = attempts + 1
       WHERE id = $1`,
      [row.id]
    );

    await client.query("COMMIT");

    const handler = handlers[row.event_type as keyof typeof handlers];
    if (!handler) {
      throw new Error(`Unknown event type: ${row.event_type}`);
    }

    try {
      await handler(
        {
          id: row.id,
          project_id: row.project_id,
          event_type: row.event_type,
          payload: row.payload,
          created_at: row.created_at,
          attempts: Number(row.attempts ?? 0) + 1,
        },
        client
      );

      await client.query(
        "UPDATE outbox_events SET processed_at = now(), error = NULL, processing_expires_at = NULL WHERE id = $1",
        [row.id]
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await client.query(
        "UPDATE outbox_events SET processed_at = now(), error = $2, processing_expires_at = NULL WHERE id = $1",
        [row.id, message.slice(0, 1000)]
      );
      throw err;
    }

    return true;
  } finally {
    client.release();
  }
}

async function drainOutbox(projectId: string): Promise<void> {
  while (await processNextOutboxEvent(projectId)) {
    // continue until empty
  }
}

describe.sequential("admin reindex profile", () => {
  const context = createRequestContext();
  const handlers = createHandlers({ pool, context });

  let workspaceId: string | null = null;
  let projectId: string | null = null;
  let embeddingProfileId: string | null = null;

  beforeAll(async () => {
    const resolveResult = await handlers.projectsResolve({
      workspace_name: uniqueName("workspace"),
      repo_url: `https://example.com/${crypto.randomUUID()}.git`,
      cwd: "/tmp/memento",
      create_if_missing: true,
    });

    const resolved = resolveResult.structuredContent as {
      workspace_id: string;
      project_id: string;
    };

    workspaceId = resolved.workspace_id;
    projectId = resolved.project_id;

    const profileResult = await handlers.embeddingProfilesUpsert({
      idempotency_key: `embed-${crypto.randomUUID()}`,
      name: "fake-embeddings",
      provider: "openai_compat",
      model: "fake-embedding",
      dims: 8,
      distance: "cosine",
      provider_config: { use_fake: true },
      set_active: true,
    });

    const profile = profileResult.structuredContent as { embedding_profile_id: string };
    embeddingProfileId = profile.embedding_profile_id;
  });

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("reindex profile repopulates embeddings", async () => {
    if (!projectId || !embeddingProfileId) {
      throw new Error("project setup missing");
    }

    await handlers.memoryCommit({
      idempotency_key: `commit-${crypto.randomUUID()}`,
      entries: [
        {
          kind: "troubleshooting",
          scope: "project",
          title: "Reset issue",
          content: {
            format: "markdown",
            text: "ECONNRESET_42 happens when retry logic is missing.",
          },
        },
      ],
    });

    await drainOutbox(projectId);

    const chunkCountResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM memory_chunks WHERE project_id = $1",
      [projectId]
    );
    const chunkCount = Number(chunkCountResult.rows[0]?.count ?? 0);
    expect(chunkCount).toBeGreaterThan(0);

    await pool.query(
      "DELETE FROM chunk_embeddings WHERE embedding_profile_id = $1",
      [embeddingProfileId]
    );

    const reindexResult = await handlers.adminReindexProfile({
      idempotency_key: `reindex-${crypto.randomUUID()}`,
      embedding_profile_id: embeddingProfileId,
      mode: "enqueue",
    });

    const output = reindexResult.structuredContent as { enqueued: boolean };
    expect(output.enqueued).toBe(true);

    await drainOutbox(projectId);

    const embeddingCountResult = await pool.query(
      "SELECT COUNT(*)::int AS count FROM chunk_embeddings WHERE embedding_profile_id = $1",
      [embeddingProfileId]
    );
    const embeddingCount = Number(embeddingCountResult.rows[0]?.count ?? 0);

    expect(embeddingCount).toBe(chunkCount);
  });
});
