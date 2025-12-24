import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, createMemoryVersion, getOrCreateWorkspace, resolveProject, upsertMemoryItem } from "@memento/core";
import { createJobHandlers, pollOutboxOnce } from "../src/outboxPoller";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for worker tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

let workspaceId: string | null = null;
let projectId: string | null = null;

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("outbox poller", () => {
  beforeAll(async () => {
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
  });

  it("processes an ingest event exactly once", async () => {
    if (!projectId) throw new Error("project_id missing");

    const item = await upsertMemoryItem(pool, {
      project_id: projectId,
      scope: "project",
      kind: "note",
      title: "Worker note",
      tags: [],
      metadata: {},
    });

    const version = await createMemoryVersion(pool, {
      project_id: projectId,
      item_id: item.id,
      commit_id: null,
      content_format: "markdown",
      content_text: "# Worker\n\nContent body",
      checksum: crypto.createHash("sha256").update("worker").digest("hex"),
    });

    const event = await pool.query(
      `INSERT INTO outbox_events (project_id, event_type, payload)
       VALUES ($1, 'INGEST_VERSION', $2)
       RETURNING id`,
      [projectId, { version_id: version.id }]
    );

    const handlers = createJobHandlers();
    const first = await pollOutboxOnce(pool, handlers, { batchSize: 5, projectId });
    expect(first.processed).toBe(1);
    expect(first.errors).toBe(0);

    const second = await pollOutboxOnce(pool, handlers, { batchSize: 5, projectId });
    expect(second.processed).toBe(0);
    expect(second.errors).toBe(0);

    const chunks = await pool.query(
      "SELECT COUNT(*)::int AS count FROM memory_chunks WHERE version_id = $1",
      [version.id]
    );
    expect(Number(chunks.rows[0].count)).toBeGreaterThan(0);

    const tsv = await pool.query(
      "SELECT COUNT(*)::int AS count FROM memory_chunks WHERE version_id = $1 AND tsv IS NOT NULL",
      [version.id]
    );
    expect(Number(tsv.rows[0].count)).toBeGreaterThan(0);

    const processed = await pool.query(
      "SELECT processed_at FROM outbox_events WHERE id = $1",
      [event.rows[0].id]
    );
    expect(processed.rows[0].processed_at).toBeTruthy();
  });
});
