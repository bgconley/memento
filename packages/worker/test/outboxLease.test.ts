import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  claimOutboxEvents,
  createPool,
  finalizeOutboxSuccess,
  getOrCreateWorkspace,
  resolveProject,
} from "@memento/core";
import {
  pollOutboxOnce,
  type JobHandlers,
} from "../src/outboxPoller";

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

const throwingHandlers: JobHandlers = {
  INGEST_VERSION: async () => {
    throw new Error("boom");
  },
  EMBED_VERSION: async () => {
    throw new Error("boom");
  },
  REINDEX_PROFILE: async () => {
    throw new Error("boom");
  },
};

describe("outbox lease behavior", () => {
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

  it("leases prevent double-claiming", async () => {
    if (!projectId) throw new Error("project_id missing");

    const event = await pool.query(
      `INSERT INTO outbox_events (project_id, event_type, payload)
       VALUES ($1, 'INGEST_VERSION', $2)
       RETURNING id`,
      [projectId, { version_id: crypto.randomUUID() }]
    );

    const first = await claimOutboxEvents(pool, {
      batchSize: 5,
      leaseSeconds: 60,
      maxAttempts: 5,
      workerId: "worker-a",
      projectId,
    });
    expect(first.map((row) => row.id)).toContain(event.rows[0].id);

    const second = await claimOutboxEvents(pool, {
      batchSize: 5,
      leaseSeconds: 60,
      maxAttempts: 5,
      workerId: "worker-b",
      projectId,
    });
    expect(second.length).toBe(0);
  });

  it("increments retry_count and schedules next_attempt_at on failure", async () => {
    if (!projectId) throw new Error("project_id missing");

    const originalDelay = process.env.OUTBOX_RETRY_DELAY_SECONDS;
    const originalMaxAttempts = process.env.OUTBOX_MAX_ATTEMPTS;
    process.env.OUTBOX_RETRY_DELAY_SECONDS = "5";
    process.env.OUTBOX_MAX_ATTEMPTS = "3";

    const event = await pool.query(
      `INSERT INTO outbox_events (project_id, event_type, payload)
       VALUES ($1, 'INGEST_VERSION', $2)
       RETURNING id`,
      [projectId, { version_id: crypto.randomUUID() }]
    );

    await pollOutboxOnce(pool, throwingHandlers, { batchSize: 5, projectId });

    const row = await pool.query(
      "SELECT retry_count, next_attempt_at, processed_at FROM outbox_events WHERE id = $1",
      [event.rows[0].id]
    );

    expect(Number(row.rows[0].retry_count)).toBe(1);
    expect(row.rows[0].processed_at).toBeNull();
    expect(new Date(row.rows[0].next_attempt_at).getTime()).toBeGreaterThan(Date.now());

    if (originalDelay === undefined) {
      delete process.env.OUTBOX_RETRY_DELAY_SECONDS;
    } else {
      process.env.OUTBOX_RETRY_DELAY_SECONDS = originalDelay;
    }
    if (originalMaxAttempts === undefined) {
      delete process.env.OUTBOX_MAX_ATTEMPTS;
    } else {
      process.env.OUTBOX_MAX_ATTEMPTS = originalMaxAttempts;
    }
  });

  it("finalize only updates when lease owner matches", async () => {
    if (!projectId) throw new Error("project_id missing");

    const event = await pool.query(
      `INSERT INTO outbox_events (project_id, event_type, payload)
       VALUES ($1, 'INGEST_VERSION', $2)
       RETURNING id`,
      [projectId, { version_id: crypto.randomUUID() }]
    );

    const claimed = await claimOutboxEvents(pool, {
      batchSize: 1,
      leaseSeconds: 60,
      maxAttempts: 5,
      workerId: "worker-a",
      projectId,
    });
    expect(claimed.length).toBe(1);

    await pool.query(
      `UPDATE outbox_events
       SET locked_by = $2, lease_expires_at = now() + make_interval(secs => 60)
       WHERE id = $1`,
      [event.rows[0].id, "worker-b"]
    );

    const updated = await finalizeOutboxSuccess(pool, event.rows[0].id, "worker-a");
    expect(updated).toBe(false);

    const row = await pool.query(
      "SELECT processed_at, locked_by FROM outbox_events WHERE id = $1",
      [event.rows[0].id]
    );
    expect(row.rows[0].processed_at).toBeNull();
    expect(row.rows[0].locked_by).toBe("worker-b");
  });

  it("marks events as dead-letter after max attempts", async () => {
    if (!projectId) throw new Error("project_id missing");

    const originalMaxAttempts = process.env.OUTBOX_MAX_ATTEMPTS;
    process.env.OUTBOX_MAX_ATTEMPTS = "2";

    const event = await pool.query(
      `INSERT INTO outbox_events (project_id, event_type, payload, retry_count)
       VALUES ($1, 'INGEST_VERSION', $2, 1)
       RETURNING id`,
      [projectId, { version_id: crypto.randomUUID() }]
    );

    await pollOutboxOnce(pool, throwingHandlers, { batchSize: 5, projectId });

    const row = await pool.query(
      "SELECT retry_count, processed_at FROM outbox_events WHERE id = $1",
      [event.rows[0].id]
    );

    expect(Number(row.rows[0].retry_count)).toBeGreaterThanOrEqual(2);
    expect(row.rows[0].processed_at).not.toBeNull();

    const reclaim = await claimOutboxEvents(pool, {
      batchSize: 5,
      leaseSeconds: 60,
      maxAttempts: 2,
      workerId: "worker-c",
      projectId,
    });
    expect(reclaim.length).toBe(0);

    if (originalMaxAttempts === undefined) {
      delete process.env.OUTBOX_MAX_ATTEMPTS;
    } else {
      process.env.OUTBOX_MAX_ATTEMPTS = originalMaxAttempts;
    }
  });
});
