import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createMemoryVersion,
  createPool,
  activateEmbeddingProfile,
  getOrCreateWorkspace,
  resolveProject,
  upsertEmbeddingProfile,
  upsertMemoryItem,
} from "@memento/core";
import { createJobHandlers, pollOutboxOnce } from "../src/outboxPoller";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for worker tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

let workspaceId: string | null = null;
let projectId: string | null = null;
const originalFake = process.env.EMBEDDER_USE_FAKE;

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("embed version job", () => {
  beforeAll(async () => {
    process.env.EMBEDDER_USE_FAKE = "true";

    const workspace = await getOrCreateWorkspace(pool, uniqueName("workspace"));
    workspaceId = workspace.id;

    const project = await resolveProject(pool, {
      workspace_id: workspace.id,
      repo_url: `https://example.com/${crypto.randomUUID()}.git`,
      cwd: null,
      project_key: null,
      display_name: null,
      create_if_missing: true,
    });
    projectId = project.id;
  });

  beforeEach(async () => {
    if (projectId) {
      await pool.query("DELETE FROM outbox_events WHERE project_id = $1", [projectId]);
    }
  });

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
    if (originalFake === undefined) {
      delete process.env.EMBEDDER_USE_FAKE;
    } else {
      process.env.EMBEDDER_USE_FAKE = originalFake;
    }
  });

  it("embeds chunks and upserts into chunk_embeddings", async () => {
    if (!projectId) throw new Error("project_id missing");

    const item = await upsertMemoryItem(pool, {
      project_id: projectId,
      scope: "project",
      kind: "note",
      title: "Embed note",
      tags: [],
      metadata: {},
    });

    const version = await createMemoryVersion(pool, {
      project_id: projectId,
      item_id: item.id,
      commit_id: null,
      content_format: "markdown",
      content_text: "# Embed\n\nContent body",
      checksum: crypto.createHash("sha256").update("embed").digest("hex"),
    });

    await pool.query(
      `INSERT INTO outbox_events (project_id, event_type, payload)
       VALUES ($1, 'INGEST_VERSION', $2)`,
      [projectId, { version_id: version.id }]
    );

    const handlers = createJobHandlers();
    await pollOutboxOnce(pool, handlers, { batchSize: 5, projectId });

    const { profile } = await upsertEmbeddingProfile(pool, {
      project_id: projectId,
      name: uniqueName("profile"),
      provider: "voyage",
      model: "voyage-3",
      dims: 8,
      distance: "cosine",
      provider_config: { use_fake: true },
    });

    await activateEmbeddingProfile(pool, projectId, profile.id);

    await pool.query(
      `INSERT INTO outbox_events (project_id, event_type, payload)
       VALUES ($1, 'EMBED_VERSION', $2)`,
      [projectId, { version_id: version.id }]
    );

    await pollOutboxOnce(pool, handlers, { batchSize: 5, projectId });

    const chunkCount = await pool.query(
      "SELECT COUNT(*)::int AS count FROM memory_chunks WHERE version_id = $1",
      [version.id]
    );
    const embeddingCount = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM chunk_embeddings ce
       JOIN memory_chunks mc ON mc.id = ce.chunk_id
       WHERE mc.version_id = $1 AND ce.embedding_profile_id = $2`,
      [version.id, profile.id]
    );

    expect(Number(embeddingCount.rows[0].count)).toBe(Number(chunkCount.rows[0].count));
  });
});
