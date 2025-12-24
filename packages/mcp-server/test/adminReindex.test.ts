import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHandlers } from "../src/handlers";
import { createRequestContext } from "../src/context";
import { createPool } from "@memento/core";
import { createJobHandlers, pollOutboxOnce } from "../../worker/src/outboxPoller";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for admin reindex tests");
}

process.env.EMBEDDER_USE_FAKE = "1";

const pool = createPool({ connectionString: DATABASE_URL });
const originalSkipIndex = process.env.MEMENTO_SKIP_INDEX_BUILD;

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function drainOutbox(projectId: string): Promise<void> {
  const handlers = createJobHandlers();
  for (let i = 0; i < 50; i += 1) {
    const result = await pollOutboxOnce(pool, handlers, { batchSize: 5, projectId });
    if (result.processed === 0 && result.errors === 0) return;
    if (result.processed === 0 && result.errors > 0) {
      throw new Error("Outbox stalled with errors");
    }
  }
  throw new Error("Outbox did not drain");
}

describe.sequential("admin reindex profile", () => {
  const context = createRequestContext();
  const handlers = createHandlers({ pool, context });

  let workspaceId: string | null = null;
  let projectId: string | null = null;
  let embeddingProfileId: string | null = null;

  beforeAll(async () => {
    process.env.MEMENTO_SKIP_INDEX_BUILD = "1";
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
    if (originalSkipIndex === undefined) {
      delete process.env.MEMENTO_SKIP_INDEX_BUILD;
    } else {
      process.env.MEMENTO_SKIP_INDEX_BUILD = originalSkipIndex;
    }
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
  }, 20000);
});
