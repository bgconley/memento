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

export type EnqueueOutboxInput = {
  project_id: string;
  event_type: string;
  payload: Record<string, unknown>;
};

export type PollOutboxInput = {
  project_id: string;
  limit: number;
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
