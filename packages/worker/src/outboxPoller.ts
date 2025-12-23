import type { Pool, PoolClient } from "pg";
import { ingestVersion } from "./jobs/ingestVersion";
import { embedVersion } from "./jobs/embedVersion";
import { reindexProfile } from "./jobs/reindexProfile";

export type OutboxEvent = {
  id: string;
  project_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
  attempts: number;
};

export type PollerOptions = {
  batchSize: number;
};

export type PollerResult = {
  processed: number;
  errors: number;
};

export type JobHandler = (event: OutboxEvent, client: PoolClient) => Promise<void>;

export type JobHandlers = {
  INGEST_VERSION: JobHandler;
  EMBED_VERSION: JobHandler;
  REINDEX_PROFILE: JobHandler;
};

const DEFAULT_LEASE_SECONDS = 300;
const DEFAULT_RETRY_DELAY_SECONDS = 60;
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
    INGEST_VERSION: async (event, client) => {
      await ingestVersion(event, client);
    },
    EMBED_VERSION: async (event, client) => {
      await embedVersion(event, client);
    },
    REINDEX_PROFILE: async (event, client) => {
      await reindexProfile(event, client);
    },
  };
}

export async function pollOutboxOnce(
  pool: Pool,
  handlers: JobHandlers,
  options: PollerOptions
): Promise<PollerResult> {
  const client = await pool.connect();
  const leaseSeconds = getEnvNumber("OUTBOX_LEASE_SECONDS", DEFAULT_LEASE_SECONDS, 10, 3600);
  const retryDelaySeconds = getEnvNumber(
    "OUTBOX_RETRY_DELAY_SECONDS",
    DEFAULT_RETRY_DELAY_SECONDS,
    5,
    3600
  );
  const maxAttempts = getEnvNumber("OUTBOX_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, 1, 25);

  let leased: OutboxEvent[] = [];
  let errorCount = 0;
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT id, project_id, event_type, payload, created_at, attempts
       FROM outbox_events
       WHERE processed_at IS NULL
         AND (processing_expires_at IS NULL OR processing_expires_at < now())
       ORDER BY created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [options.batchSize]
    );

    const events = result.rows.map((row) => ({
      ...row,
      attempts: Number(row.attempts ?? 0),
    })) as OutboxEvent[];

    if (events.length === 0) {
      await client.query("COMMIT");
      leased = [];
    } else {
      const ids = events.map((event) => event.id);
      const leaseUpdate = await client.query(
        `UPDATE outbox_events
         SET processing_started_at = now(),
             processing_expires_at = now() + ($1 || ' seconds')::interval,
             attempts = attempts + 1
         WHERE id = ANY($2::uuid[])
         RETURNING id, attempts`,
        [leaseSeconds, ids]
      );

      const attemptMap = new Map<string, number>();
      for (const row of leaseUpdate.rows) {
        attemptMap.set(row.id as string, Number(row.attempts));
      }

      leased = events.map((event) => ({
        ...event,
        attempts: attemptMap.get(event.id) ?? event.attempts + 1,
      }));

      await client.query("COMMIT");
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
  try {
    for (const event of leased) {
      try {
        const handler = handlers[event.event_type as keyof JobHandlers];
        if (!handler) {
          throw new Error(`Unknown event_type: ${event.event_type}`);
        }
        await handler(event, client);
        await client.query(
          "UPDATE outbox_events SET processed_at = now(), error = NULL, processing_expires_at = NULL WHERE id = $1",
          [event.id]
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errorCount += 1;
        if (event.attempts >= maxAttempts) {
          await client.query(
            "UPDATE outbox_events SET processed_at = now(), error = $2, processing_expires_at = NULL WHERE id = $1",
            [event.id, message.slice(0, 1000)]
          );
        } else {
          await client.query(
            `UPDATE outbox_events
             SET error = $2,
                 processing_expires_at = now() + ($3 || ' seconds')::interval
             WHERE id = $1`,
            [event.id, message.slice(0, 1000), retryDelaySeconds]
          );
        }
      }
    }
  } finally {
    client.release();
  }

  return { processed: leased.length, errors: errorCount };
}
