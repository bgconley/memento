import type { DbClient } from "../db";
import { applyProjectScope, NotFoundError, ValidationError } from "../db";

export type MemoryVersionRow = {
  id: string;
  project_id: string;
  item_id: string;
  commit_id: string | null;
  version_num: number;
  content_format: string;
  content_text: string;
  content_json: Record<string, unknown> | null;
  checksum: string;
  created_at: string;
};

export type CreateMemoryVersionInput = {
  project_id: string;
  item_id: string;
  commit_id?: string | null;
  content_format: string;
  content_text: string;
  content_json?: Record<string, unknown> | null;
  checksum: string;
};

export async function createMemoryVersion(
  client: DbClient,
  input: CreateMemoryVersionInput
): Promise<MemoryVersionRow> {
  if (!input.project_id) {
    throw new ValidationError("project_id is required");
  }
  if (!input.item_id) {
    throw new ValidationError("item_id is required");
  }

  const versionResult = await client.query(
    "SELECT COALESCE(MAX(version_num), 0) + 1 AS next_version FROM memory_versions WHERE item_id = $1",
    [input.item_id]
  );

  const nextVersion = Number(versionResult.rows[0]?.next_version ?? 1);

  const insertResult = await client.query(
    `INSERT INTO memory_versions (
      project_id,
      item_id,
      commit_id,
      version_num,
      content_format,
      content_text,
      content_json,
      checksum
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id, project_id, item_id, commit_id, version_num, content_format, content_text, content_json, checksum, created_at`,
    [
      input.project_id,
      input.item_id,
      input.commit_id ?? null,
      nextVersion,
      input.content_format,
      input.content_text,
      input.content_json ?? null,
      input.checksum,
    ]
  );

  return insertResult.rows[0];
}

export async function getLatestMemoryVersion(
  client: DbClient,
  projectId: string,
  itemId: string
): Promise<MemoryVersionRow | null> {
  const scoped = applyProjectScope(
    {
      text: "SELECT id, project_id, item_id, commit_id, version_num, content_format, content_text, content_json, checksum, created_at FROM memory_versions WHERE item_id = $1 AND {{project_scope}} ORDER BY version_num DESC LIMIT 1",
      values: [itemId],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  return result.rows[0] ?? null;
}

export async function getMemoryVersion(
  client: DbClient,
  projectId: string,
  itemId: string,
  versionNum: number
): Promise<MemoryVersionRow> {
  const scoped = applyProjectScope(
    {
      text: "SELECT id, project_id, item_id, commit_id, version_num, content_format, content_text, content_json, checksum, created_at FROM memory_versions WHERE item_id = $1 AND version_num = $2 AND {{project_scope}}",
      values: [itemId, versionNum],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  if (!result.rows[0]) {
    throw new NotFoundError("Memory version not found", {
      item_id: itemId,
      version_num: versionNum,
    });
  }

  return result.rows[0];
}

export async function listMemoryVersions(
  client: DbClient,
  projectId: string,
  itemId: string,
  limit: number,
  offset: number
): Promise<MemoryVersionRow[]> {
  const scoped = applyProjectScope(
    {
      text: "SELECT id, project_id, item_id, commit_id, version_num, content_format, content_text, content_json, checksum, created_at FROM memory_versions WHERE item_id = $1 AND {{project_scope}} ORDER BY version_num DESC LIMIT $2 OFFSET $3",
      values: [itemId, limit, offset],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  return result.rows;
}
