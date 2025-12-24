import os from "node:os";
import type { Pool } from "pg";
import { ingestVersion } from "./jobs/ingestVersion";
import { embedVersion } from "./jobs/embedVersion";
import { reindexProfile } from "./jobs/reindexProfile";

export type OutboxEvent = {
  id: string;
  project_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
  retry_count: number;
  next_attempt_at: string | null;
  locked_by?: string | null;
  lease_expires_at?: string | null;
};

export type PollerOptions = {
  batchSize: number;
  projectId?: string;
};

export type PollerResult = {
  processed: number;
  errors: number;
};

export type JobHandler = (event: OutboxEvent, pool: Pool) => Promise<void>;

export type JobHandlers = {
  INGEST_VERSION: JobHandler;
  EMBED_VERSION: JobHandler;
  REINDEX_PROFILE: JobHandler;
};

const DEFAULT_LEASE_SECONDS = 120;
const DEFAULT_RETRY_DELAY_SECONDS = 5;
const DEFAULT_RETRY_MAX_DELAY_SECONDS = 600;
const DEFAULT_MAX_ATTEMPTS = 5;

function readNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function getEnvNumber(name: string, fallback: number, min: number, max: number): number {
  const value = readNumber(process.env[name]);
  if (value === undefined) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function createJobHandlers(): JobHandlers {
  return {
    INGEST_VERSION: async (event, pool) => {
      await ingestVersion(event, pool);
    },
    EMBED_VERSION: async (event, pool) => {
      await embedVersion(event, pool);
    },
    REINDEX_PROFILE: async (event, pool) => {
      await reindexProfile(event, pool);
    },
  };
}

export async function pollOutboxOnce(
  pool: Pool,
  handlers: JobHandlers,
  options: PollerOptions
): Promise<PollerResult> {
  const leaseSeconds = getEnvNumber("OUTBOX_LEASE_SECONDS", DEFAULT_LEASE_SECONDS, 10, 3600);
  const retryDelaySeconds = getEnvNumber(
    "OUTBOX_RETRY_DELAY_SECONDS",
    DEFAULT_RETRY_DELAY_SECONDS,
    5,
    3600
  );
  const maxRetryDelaySeconds = getEnvNumber(
    "OUTBOX_RETRY_MAX_DELAY_SECONDS",
    DEFAULT_RETRY_MAX_DELAY_SECONDS,
    retryDelaySeconds,
    86400
  );
  const maxAttempts = getEnvNumber("OUTBOX_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, 1, 25);
  const workerId = process.env.WORKER_ID ?? `${os.hostname()}:${process.pid}`;

  let errorCount = 0;
  const leased = await claimEvents(pool, {
    batchSize: options.batchSize,
    leaseSeconds,
    maxAttempts,
    workerId,
    projectId: options.projectId,
  });

  try {
    for (const event of leased) {
      try {
        const handler = handlers[event.event_type as keyof JobHandlers];
        if (!handler) {
          throw new Error(`Unknown event_type: ${event.event_type}`);
        }
        await handler(event, pool);
        await finalizeEventSuccess(pool, event.id, workerId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errorCount += 1;
        await finalizeEventFailure(pool, {
          event,
          workerId,
          message,
          maxAttempts,
          retryDelaySeconds,
          maxRetryDelaySeconds,
        });
      }
    }
  } finally {
    // no-op, pool is shared
  }

  return { processed: leased.length, errors: errorCount };
}

type ClaimOptions = {
  batchSize: number;
  leaseSeconds: number;
  maxAttempts: number;
  workerId: string;
  projectId?: string;
};

type OutboxEventRow = {
  id: string;
  project_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
  retry_count: number | null;
  next_attempt_at: string | null;
};

export async function claimEvents(pool: Pool, options: ClaimOptions): Promise<OutboxEvent[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<OutboxEventRow>(
      `WITH candidate AS (
         SELECT id
         FROM outbox_events
         WHERE processed_at IS NULL
           AND (next_attempt_at IS NULL OR next_attempt_at <= now())
           AND (lease_expires_at IS NULL OR lease_expires_at < now())
           AND retry_count < $1
           AND ($5::uuid IS NULL OR project_id = $5)
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $2
       )
       UPDATE outbox_events e
       SET locked_at = now(),
           locked_by = $3,
           lease_expires_at = now() + make_interval(secs => $4)
       FROM candidate
       WHERE e.id = candidate.id
       RETURNING e.id, e.project_id, e.event_type, e.payload, e.created_at, e.retry_count, e.next_attempt_at`,
      [
        options.maxAttempts,
        options.batchSize,
        options.workerId,
        options.leaseSeconds,
        options.projectId ?? null,
      ]
    );
    await client.query("COMMIT");
    return result.rows.map((row) => ({
      ...row,
      retry_count: Number(row.retry_count ?? 0),
    })) as OutboxEvent[];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function finalizeEventSuccess(
  pool: Pool,
  eventId: string,
  workerId: string
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE outbox_events
     SET processed_at = now(),
         error = NULL,
         locked_at = NULL,
         locked_by = NULL,
         lease_expires_at = NULL,
         next_attempt_at = NULL
     WHERE id = $1
       AND locked_by = $2
       AND processed_at IS NULL`,
    [eventId, workerId]
  );
  return (result.rowCount ?? 0) > 0;
}

type FailureOptions = {
  event: OutboxEvent;
  workerId: string;
  message: string;
  maxAttempts: number;
  retryDelaySeconds: number;
  maxRetryDelaySeconds: number;
};

export async function finalizeEventFailure(
  pool: Pool,
  options: FailureOptions
): Promise<boolean> {
  const { event, workerId, message, maxAttempts, retryDelaySeconds, maxRetryDelaySeconds } = options;
  const nextRetryCount = event.retry_count + 1;
  const trimmedMessage = message.slice(0, 1000);

  if (nextRetryCount >= maxAttempts) {
    const result = await pool.query(
      `UPDATE outbox_events
       SET processed_at = now(),
           error = $2,
           retry_count = $3,
           locked_at = NULL,
           locked_by = NULL,
           lease_expires_at = NULL,
           next_attempt_at = NULL
       WHERE id = $1
         AND locked_by = $4
         AND processed_at IS NULL`,
      [event.id, trimmedMessage, nextRetryCount, workerId]
    );
    return (result.rowCount ?? 0) > 0;
  }

  const backoffSeconds = Math.min(
    retryDelaySeconds * Math.pow(2, nextRetryCount - 1),
    maxRetryDelaySeconds
  );
  const nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000);

  const result = await pool.query(
    `UPDATE outbox_events
     SET error = $2,
         retry_count = $3,
         next_attempt_at = $4,
         locked_at = NULL,
         locked_by = NULL,
         lease_expires_at = NULL
     WHERE id = $1
       AND locked_by = $5
       AND processed_at IS NULL`,
    [event.id, trimmedMessage, nextRetryCount, nextAttemptAt, workerId]
  );
  return (result.rowCount ?? 0) > 0;
}
