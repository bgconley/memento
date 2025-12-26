import type { Pool } from "pg";
import type { DbClient } from "../db";
import { applyProjectScope, NotFoundError, ValidationError } from "../db";

export type OutboxEventRow = {
  id: string;
  project_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
  processed_at: string | null;
  error: string | null;
};

export type OutboxLeaseEvent = {
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

export type EnqueueOutboxInput = {
  project_id: string;
  event_type: string;
  payload: Record<string, unknown>;
};

export type PollOutboxInput = {
  project_id: string;
  limit: number;
};

export type ClaimOutboxOptions = {
  batchSize: number;
  leaseSeconds: number;
  maxAttempts: number;
  workerId: string;
  projectId?: string;
};

export type FinalizeFailureOptions = {
  event: OutboxLeaseEvent;
  workerId: string;
  message: string;
  maxAttempts: number;
  retryDelaySeconds: number;
  maxRetryDelaySeconds: number;
};

export async function enqueueOutboxEvent(
  client: DbClient,
  input: EnqueueOutboxInput
): Promise<OutboxEventRow> {
  if (!input.project_id) {
    throw new ValidationError("project_id is required");
  }

  const result = await client.query(
    `INSERT INTO outbox_events (project_id, event_type, payload)
     VALUES ($1, $2, $3)
     RETURNING id, project_id, event_type, payload, created_at, processed_at, error`,
    [input.project_id, input.event_type, input.payload]
  );

  return result.rows[0];
}

export async function claimOutboxEvents(
  pool: Pool,
  options: ClaimOutboxOptions
): Promise<OutboxLeaseEvent[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
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
    })) as OutboxLeaseEvent[];
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function finalizeOutboxSuccess(
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

export async function finalizeOutboxFailure(
  pool: Pool,
  options: FinalizeFailureOptions
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

export async function pollOutboxEvents(
  client: DbClient,
  input: PollOutboxInput
): Promise<OutboxEventRow[]> {
  const scoped = applyProjectScope(
    {
      text: "SELECT id, project_id, event_type, payload, created_at, processed_at, error FROM outbox_events WHERE processed_at IS NULL AND {{project_scope}} ORDER BY created_at ASC LIMIT $1",
      values: [input.limit],
    },
    input.project_id,
    "project_id"
  );

  const result = await client.query(scoped);
  return result.rows;
}

export async function markOutboxProcessed(
  client: DbClient,
  projectId: string,
  eventId: string
): Promise<OutboxEventRow> {
  const scoped = applyProjectScope(
    {
      text: "UPDATE outbox_events SET processed_at = now(), error = NULL WHERE id = $1 AND {{project_scope}} RETURNING id, project_id, event_type, payload, created_at, processed_at, error",
      values: [eventId],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  if (!result.rows[0]) {
    throw new NotFoundError("Outbox event not found", { event_id: eventId });
  }

  return result.rows[0];
}

export async function markOutboxError(
  client: DbClient,
  projectId: string,
  eventId: string,
  error: string
): Promise<OutboxEventRow> {
  const scoped = applyProjectScope(
    {
      text: "UPDATE outbox_events SET processed_at = now(), error = $2 WHERE id = $1 AND {{project_scope}} RETURNING id, project_id, event_type, payload, created_at, processed_at, error",
      values: [eventId, error],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  if (!result.rows[0]) {
    throw new NotFoundError("Outbox event not found", { event_id: eventId });
  }

  return result.rows[0];
}
