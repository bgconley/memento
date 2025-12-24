import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db";
import { getOrCreateWorkspace } from "../../src/repos/workspaces";
import { resolveProject } from "../../src/repos/projects";
import { ensureProfileIndex } from "../../src/vector";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for vector tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

let workspaceId: string | null = null;
let projectId: string | null = null;
let indexName: string | null = null;

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("vector index manager", () => {
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
    if (indexName) {
      await pool.query(`DROP INDEX IF EXISTS ${indexName}`);
    }
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("creates per-profile hnsw index", async () => {
    if (!projectId) throw new Error("project_id missing");

    const profileName = uniqueName("profile");
    const profileResult = await pool.query(
      `INSERT INTO embedding_profiles (project_id, name, provider, model, dims, distance)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [projectId, profileName, "openai_compat", "local-embed", 8, "cosine"]
    );

    const profileId = profileResult.rows[0].id as string;

    const result = await ensureProfileIndex(pool, profileId, 8, "cosine", { concurrently: true });
    expect(result.indexName).toBeTruthy();
    indexName = result.indexName;

    const indexCheck = await pool.query(
      "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1",
      [result.indexName]
    );
    expect(indexCheck.rowCount).toBe(1);
  });
});
