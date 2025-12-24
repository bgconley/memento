import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db";
import { getOrCreateWorkspace } from "../../src/repos/workspaces";
import { resolveProject } from "../../src/repos/projects";
import { createMemoryVersion } from "../../src/repos/memoryVersions";
import { upsertMemoryItem } from "../../src/repos/memoryItems";
import { lexicalSearch } from "../../src/search/lexical";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for lexical search tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

let workspaceId: string | null = null;
let projectId: string | null = null;

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("lexical search", () => {
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

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("finds token-like troubleshooting entries", async () => {
    if (!projectId) throw new Error("project_id missing");

    const item = await upsertMemoryItem(pool, {
      project_id: projectId,
      scope: "project",
      kind: "troubleshooting",
      title: "Connection reset",
      tags: ["network"],
      metadata: {},
    });

    const content = "Error ECONNRESET_42 while calling service";
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

    const results = await lexicalSearch(pool, {
      project_id: projectId,
      query: "ECONNRESET_42",
      filters: { kinds: ["troubleshooting"] },
      options: { top_k: 5, max_chunk_chars: 200 },
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].item_id).toBe(item.id);
    expect(results[0].trigram_score).toBeGreaterThan(0);
  });
});
