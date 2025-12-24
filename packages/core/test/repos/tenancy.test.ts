import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../src/db";
import { getOrCreateWorkspace } from "../../src/repos/workspaces";
import { resolveProject } from "../../src/repos/projects";
import { startSession, endSession } from "../../src/repos/sessions";
import { insertOrGetCommit } from "../../src/repos/commits";

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL must be set for repo tests");
}

const pool = createPool({ connectionString: DATABASE_URL });

let workspaceId: string | null = null;

function uniqueName(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

describe("tenancy repos", () => {
  beforeAll(async () => {
    const workspace = await getOrCreateWorkspace(pool, uniqueName("workspace"));
    workspaceId = workspace.id;
  });

  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("resolves project, starts/ends session, and dedupes commits", async () => {
    if (!workspaceId) throw new Error("workspace_id missing");

    const repoUrl = `https://example.com/${crypto.randomUUID()}.git`;
    const project = await resolveProject(pool, {
      workspace_id: workspaceId,
      repo_url: repoUrl,
      cwd: null,
      project_key: null,
      display_name: null,
      create_if_missing: true,
    });

    expect(project.workspace_id).toBe(workspaceId);
    expect(project.repo_url).toBe(repoUrl);

    const session = await startSession(pool, {
      project_id: project.id,
      client_name: "codex-tui",
      metadata: { test: true },
    });

    expect(session.project_id).toBe(project.id);

    const ended = await endSession(pool, project.id, session.id);
    expect(ended.session_id).toBe(session.id);
    expect(ended.ended_at).toBeTruthy();

    const idempotencyKey = `commit-${crypto.randomUUID()}`;
    const firstCommit = await insertOrGetCommit(pool, {
      project_id: project.id,
      session_id: session.id,
      idempotency_key: idempotencyKey,
      author: "tester",
      summary: "initial",
    });

    const secondCommit = await insertOrGetCommit(pool, {
      project_id: project.id,
      session_id: session.id,
      idempotency_key: idempotencyKey,
      author: "tester",
      summary: "initial",
    });

    expect(firstCommit.commit_id).toBe(secondCommit.commit_id);
    expect(firstCommit.deduped).toBe(false);
    expect(secondCommit.deduped).toBe(true);
  });
});
