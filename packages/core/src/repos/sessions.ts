import type { DbClient } from "../db";
import { applyProjectScope, NotFoundError, ValidationError } from "../db";

export type SessionRow = {
  id: string;
  project_id: string;
  client_name: string;
  started_at: string;
  ended_at: string | null;
  metadata: Record<string, unknown>;
};

export type StartSessionInput = {
  project_id: string;
  client_name: string;
  metadata: Record<string, unknown>;
};

export async function startSession(client: DbClient, input: StartSessionInput): Promise<SessionRow> {
  if (!input.project_id) {
    throw new ValidationError("project_id is required");
  }

  const result = await client.query(
    "INSERT INTO sessions (project_id, client_name, metadata) VALUES ($1, $2, $3) RETURNING id, project_id, client_name, started_at, ended_at, metadata",
    [input.project_id, input.client_name, input.metadata]
  );

  return result.rows[0];
}

export async function endSession(
  client: DbClient,
  projectId: string,
  sessionId: string
): Promise<{ session_id: string; ended_at: string }>{
  const scoped = applyProjectScope(
    {
      text: "UPDATE sessions SET ended_at = COALESCE(ended_at, now()) WHERE id = $1 AND {{project_scope}} RETURNING id, ended_at",
      values: [sessionId],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  if (!result.rows[0]) {
    throw new NotFoundError("Session not found", { session_id: sessionId });
  }

  return { session_id: result.rows[0].id, ended_at: result.rows[0].ended_at };
}
