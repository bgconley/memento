import crypto from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPool, createMemoryVersion, upsertMemoryItem } from "@memento/core";
import { createHandlers } from "../src/handlers";
import { createRequestContext } from "../src/context";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for mcp-server tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

let workspaceId: string | null = null;

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("health.check + search + restore", () => {
  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("reports health, performs lexical search, and builds restore bundle", async () => {
    const context = createRequestContext();
    const handlers = createHandlers({ pool, context });

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

    const item = await upsertMemoryItem(pool, {
      project_id: resolved.project_id,
      scope: "project",
      kind: "spec",
      canonical_key: "app",
      title: "MyApp Spec",
      pinned: true,
      tags: [],
      metadata: {},
    });

    const version = await createMemoryVersion(pool, {
      project_id: resolved.project_id,
      item_id: item.id,
      commit_id: null,
      content_format: "markdown",
      content_text: "Authentication flow",
      checksum: crypto.createHash("sha256").update("Authentication flow").digest("hex"),
    });

    await pool.query(
      `INSERT INTO memory_chunks (project_id, version_id, chunk_index, chunk_text, tsv)
       VALUES ($1, $2, 0, $3, to_tsvector('english', $3))`,
      [resolved.project_id, version.id, "Authentication flow for MyApp"]
    );

    const healthResult = await handlers.healthCheck({});
    const health = healthResult.structuredContent as {
      ok: boolean;
      database_ok: boolean;
      worker_backlog: number;
      active_embedding_profile_id: string | null;
      time: string;
    };
    expect(health.database_ok).toBe(true);
    expect(health.worker_backlog).toBeGreaterThanOrEqual(0);

    const searchResult = await handlers.memorySearch({
      query: "authentication",
      include_chunks: true,
      max_chunk_chars: 200,
    });
    const search = searchResult.structuredContent as { results: Array<unknown> };
    expect(search.results.length).toBeGreaterThan(0);

    const restoreResult = await handlers.memoryRestore({
      max_items: 5,
      include_context_pack: true,
    });
    const restore = restoreResult.structuredContent as {
      items: Array<{ item_id: string }>;
      context_pack?: { sections: Array<unknown> };
    };
    expect(restore.items.length).toBeGreaterThan(0);
    expect(restore.context_pack).toBeTruthy();
  });
});
