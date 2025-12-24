import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db";
import { getOrCreateWorkspace } from "../../src/repos/workspaces";
import { resolveProject } from "../../src/repos/projects";
import { createMemoryVersion } from "../../src/repos/memoryVersions";
import { upsertMemoryItem } from "../../src/repos/memoryItems";
import { getBm25Capabilities } from "../../src/search/bm25/capabilities";
import { lexicalBm25 } from "../../src/search/bm25/lexicalBm25";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for lexical search tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

let workspaceId: string | null = null;
let projectId: string | null = null;
let capabilities: Awaited<ReturnType<typeof getBm25Capabilities>> = null;

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("lexical bm25 search", () => {
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

    capabilities = await getBm25Capabilities(pool);
  });

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("queries bm25 when available", async () => {
    if (!capabilities || !projectId) return;

    const item = await upsertMemoryItem(pool, {
      project_id: projectId,
      scope: "project",
      kind: "note",
      title: "BM25 note",
      tags: ["bm25"],
      metadata: {},
    });

    const content = "BM25 should rank this document";
    const version = await createMemoryVersion(pool, {
      project_id: projectId,
      item_id: item.id,
      commit_id: null,
      content_format: "markdown",
      content_text: content,
      checksum: crypto.createHash("sha256").update(content).digest("hex"),
    });

    await pool.query(
      `INSERT INTO memory_chunks (version_id, chunk_index, chunk_text, tsv)
       VALUES ($1, 0, $2, to_tsvector('english', $2))`,
      [version.id, content]
    );

    const results = await lexicalBm25(pool, {
      project_id: projectId,
      query: "BM25",
      filters: { tags_all: ["bm25"] },
      capabilities,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].item_id).toBe(item.id);
  });
});
