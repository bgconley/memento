import os from "node:os";
import type { Pool } from "pg";
import {
  claimOutboxEvents,
  finalizeOutboxFailure,
  finalizeOutboxSuccess,
  type OutboxLeaseEvent,
} from "@memento/core";
import { createLogger } from "@memento/shared";
import { ingestVersion } from "./jobs/ingestVersion";
import { embedVersion } from "./jobs/embedVersion";
import { reindexProfile } from "./jobs/reindexProfile";

export type OutboxEvent = OutboxLeaseEvent;

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

const logger = createLogger({ component: "outbox-poller" });

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
  const leased = await claimOutboxEvents(pool, {
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
        try {
          await finalizeOutboxSuccess(pool, event.id, workerId);
        } catch (err) {
          errorCount += 1;
          logger.error("outbox.finalize_success_failed", { event_id: event.id, err });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errorCount += 1;
        try {
          await finalizeOutboxFailure(pool, {
            event,
            workerId,
            message,
            maxAttempts,
            retryDelaySeconds,
            maxRetryDelaySeconds,
          });
        } catch (finalizeErr) {
          logger.error("outbox.finalize_failure_failed", {
            event_id: event.id,
            err: finalizeErr,
          });
        }
      }
    }
  } finally {
    // no-op, pool is shared
  }

  return { processed: leased.length, errors: errorCount };
}
