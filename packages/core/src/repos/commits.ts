import type { DbClient } from "../db";
import { applyProjectScope, NotFoundError, ValidationError } from "../db";

export type CommitRow = {
  id: string;
  project_id: string;
  session_id: string | null;
  idempotency_key: string;
  author: string | null;
  summary: string | null;
  created_at: string;
};

export type CommitInput = {
  project_id: string;
  session_id?: string | null;
  idempotency_key: string;
  author?: string | null;
  summary?: string | null;
};

export async function insertOrGetCommit(
  client: DbClient,
  input: CommitInput
): Promise<{ commit_id: string; deduped: boolean }> {
  if (!input.project_id) {
    throw new ValidationError("project_id is required");
  }
  if (!input.idempotency_key) {
    throw new ValidationError("idempotency_key is required");
  }

  const insertResult = await client.query(
    "INSERT INTO commits (project_id, session_id, idempotency_key, author, summary) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (project_id, idempotency_key) DO NOTHING RETURNING id",
    [
      input.project_id,
      input.session_id ?? null,
      input.idempotency_key,
      input.author ?? null,
      input.summary ?? null,
    ]
  );

  if (insertResult.rows[0]) {
    return { commit_id: insertResult.rows[0].id, deduped: false };
  }

  const scoped = applyProjectScope(
    {
      text: "SELECT id FROM commits WHERE idempotency_key = $1 AND {{project_scope}}",
      values: [input.idempotency_key],
    },
    input.project_id,
    "project_id"
  );

  const existing = await client.query(scoped);
  if (!existing.rows[0]) {
    throw new NotFoundError("Commit not found", {
      project_id: input.project_id,
      idempotency_key: input.idempotency_key,
    });
  }

  return { commit_id: existing.rows[0].id, deduped: true };
}
