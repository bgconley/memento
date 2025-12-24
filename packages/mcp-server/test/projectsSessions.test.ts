import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "@memento/core";
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

describe("projects.resolve + sessions handlers", () => {
  afterAll(async () => {
    if (workspaceId) {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    }
    await pool.end();
  });

  it("resolves project, starts session, ends with snapshot", async () => {
    const context = createRequestContext();
    const handlers = createHandlers({ pool, context });

    const workspaceName = uniqueName("workspace");
    const resolveResult = await handlers.projectsResolve({
      workspace_name: workspaceName,
      repo_url: `https://example.com/${crypto.randomUUID()}.git`,
      cwd: "/tmp/memento",
      create_if_missing: true,
    });

    const resolved = resolveResult.structuredContent as {
      workspace_id: string;
      project_id: string;
      project_key: string;
      display_name: string;
      repo_url: string | null;
    };

    workspaceId = resolved.workspace_id;

    const sessionStartResult = await handlers.sessionsStart({
      client_name: "codex-tui",
      metadata: { test: true },
    });

    const sessionStart = sessionStartResult.structuredContent as {
      session_id: string;
      started_at: string;
    };

    const idempotencyKey = `snap-${crypto.randomUUID()}`;
    const sessionEndResult = await handlers.sessionsEnd({
      session_id: sessionStart.session_id,
      create_snapshot: true,
      idempotency_key: idempotencyKey,
      summary: "session summary",
      snapshot: {
        title: "Session Snapshot",
        content: { format: "markdown", text: "snapshot body" },
        tags: ["test"],
      },
    });

    const sessionEnd = sessionEndResult.structuredContent as {
      session_id: string;
      ended_at: string;
      snapshot_item_id?: string;
      snapshot_version_id?: string;
    };

    expect(sessionEnd.session_id).toBe(sessionStart.session_id);
    expect(sessionEnd.snapshot_item_id).toBeTruthy();
    expect(sessionEnd.snapshot_version_id).toBeTruthy();

    const outbox = await pool.query(
      "SELECT event_type FROM outbox_events WHERE project_id = $1 AND payload->>'version_id' = $2",
      [resolved.project_id, sessionEnd.snapshot_version_id]
    );

    const types = outbox.rows.map((row) => row.event_type);
    expect(types).toContain("INGEST_VERSION");
    expect(types).toContain("EMBED_VERSION");
  });
});
