import type { DbClient } from "../db";
import { applyProjectScope, NotFoundError, ValidationError } from "../db";

export type MemoryItemRow = {
  id: string;
  project_id: string;
  scope: string;
  kind: string;
  canonical_key: string | null;
  doc_class: string | null;
  title: string;
  pinned: boolean;
  status: string;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type UpsertMemoryItemInput = {
  project_id: string;
  item_id?: string | null;
  canonical_key?: string | null;
  scope: string;
  kind: string;
  doc_class?: string | null;
  title: string;
  pinned?: boolean | null;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
  status?: string | null;
};

function normalizeInsertDefaults(input: UpsertMemoryItemInput) {
  return {
    pinned: input.pinned ?? false,
    tags: input.tags ?? [],
    metadata: input.metadata ?? {},
    status: input.status ?? "active",
  };
}

export async function upsertMemoryItem(
  client: DbClient,
  input: UpsertMemoryItemInput
): Promise<MemoryItemRow> {
  if (!input.project_id) {
    throw new ValidationError("project_id is required");
  }
  if (!input.kind) {
    throw new ValidationError("kind is required");
  }
  if (!input.scope) {
    throw new ValidationError("scope is required");
  }
  if (!input.title) {
    throw new ValidationError("title is required");
  }

  const { pinned, tags, metadata, status } = normalizeInsertDefaults(input);

  if (input.item_id) {
    const scoped = applyProjectScope(
      {
        text: `UPDATE memory_items
          SET kind = $2,
              scope = $3,
              doc_class = $4,
              title = $5,
              pinned = COALESCE($6, pinned),
              tags = COALESCE($7, tags),
              metadata = COALESCE($8, metadata),
              status = COALESCE($9, status),
              canonical_key = COALESCE($10, canonical_key),
              updated_at = now()
          WHERE id = $1 AND {{project_scope}}
          RETURNING id, project_id, scope, kind, canonical_key, doc_class, title, pinned, status, tags, metadata, created_at, updated_at`,
        values: [
          input.item_id,
          input.kind,
          input.scope,
          input.doc_class ?? null,
          input.title,
          input.pinned ?? null,
          input.tags ?? null,
          input.metadata ?? null,
          input.status ?? null,
          input.canonical_key ?? null,
        ],
      },
      input.project_id,
      "project_id"
    );

    const result = await client.query(scoped);
    if (!result.rows[0]) {
      throw new NotFoundError("Memory item not found", { item_id: input.item_id });
    }
    return result.rows[0];
  }

  if (input.canonical_key) {
    const result = await client.query(
      `INSERT INTO memory_items (
        project_id,
        scope,
        kind,
        canonical_key,
        doc_class,
        title,
        pinned,
        tags,
        metadata,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (project_id, canonical_key)
      DO UPDATE SET
        scope = EXCLUDED.scope,
        kind = EXCLUDED.kind,
        doc_class = EXCLUDED.doc_class,
        title = EXCLUDED.title,
        pinned = CASE WHEN $11::boolean IS NULL THEN memory_items.pinned ELSE EXCLUDED.pinned END,
        tags = CASE WHEN $12::text[] IS NULL THEN memory_items.tags ELSE EXCLUDED.tags END,
        metadata = CASE WHEN $13::jsonb IS NULL THEN memory_items.metadata ELSE EXCLUDED.metadata END,
        status = CASE WHEN $14::text IS NULL THEN memory_items.status ELSE EXCLUDED.status END,
        updated_at = now()
      RETURNING id, project_id, scope, kind, canonical_key, doc_class, title, pinned, status, tags, metadata, created_at, updated_at`,
      [
        input.project_id,
        input.scope,
        input.kind,
        input.canonical_key,
        input.doc_class ?? null,
        input.title,
        pinned,
        tags,
        metadata,
        status,
        input.pinned ?? null,
        input.tags ?? null,
        input.metadata ?? null,
        input.status ?? null,
      ]
    );

    return result.rows[0];
  }

  const insertResult = await client.query(
    `INSERT INTO memory_items (
      project_id,
      scope,
      kind,
      canonical_key,
      doc_class,
      title,
      pinned,
      tags,
      metadata,
      status
    ) VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, $9)
    RETURNING id, project_id, scope, kind, canonical_key, doc_class, title, pinned, status, tags, metadata, created_at, updated_at`,
    [
      input.project_id,
      input.scope,
      input.kind,
      input.doc_class ?? null,
      input.title,
      pinned,
      tags,
      metadata,
      status,
    ]
  );

  return insertResult.rows[0];
}

export async function getMemoryItemById(
  client: DbClient,
  projectId: string,
  itemId: string
): Promise<MemoryItemRow | null> {
  const scoped = applyProjectScope(
    {
      text: "SELECT id, project_id, scope, kind, canonical_key, doc_class, title, pinned, status, tags, metadata, created_at, updated_at FROM memory_items WHERE id = $1 AND {{project_scope}}",
      values: [itemId],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  return result.rows[0] ?? null;
}

export async function getMemoryItemByCanonicalKey(
  client: DbClient,
  projectId: string,
  canonicalKey: string
): Promise<MemoryItemRow | null> {
  const scoped = applyProjectScope(
    {
      text: "SELECT id, project_id, scope, kind, canonical_key, doc_class, title, pinned, status, tags, metadata, created_at, updated_at FROM memory_items WHERE canonical_key = $1 AND {{project_scope}}",
      values: [canonicalKey],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  return result.rows[0] ?? null;
}

export async function setMemoryItemPinned(
  client: DbClient,
  projectId: string,
  itemId: string,
  pinned: boolean
): Promise<MemoryItemRow> {
  const scoped = applyProjectScope(
    {
      text: "UPDATE memory_items SET pinned = $2, updated_at = now() WHERE id = $1 AND {{project_scope}} RETURNING id, project_id, scope, kind, canonical_key, doc_class, title, pinned, status, tags, metadata, created_at, updated_at",
      values: [itemId, pinned],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  if (!result.rows[0]) {
    throw new NotFoundError("Memory item not found", { item_id: itemId });
  }
  return result.rows[0];
}

export async function setMemoryItemStatus(
  client: DbClient,
  projectId: string,
  itemId: string,
  status: string
): Promise<MemoryItemRow> {
  const scoped = applyProjectScope(
    {
      text: "UPDATE memory_items SET status = $2, updated_at = now() WHERE id = $1 AND {{project_scope}} RETURNING id, project_id, scope, kind, canonical_key, doc_class, title, pinned, status, tags, metadata, created_at, updated_at",
      values: [itemId, status],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  if (!result.rows[0]) {
    throw new NotFoundError("Memory item not found", { item_id: itemId });
  }
  return result.rows[0];
}
