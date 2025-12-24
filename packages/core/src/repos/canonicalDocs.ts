import type { DbClient } from "../db";
import { applyProjectScope, NotFoundError, ValidationError } from "../db";
import { upsertMemoryItem, type MemoryItemRow } from "./memoryItems";

export type CanonicalDocRow = {
  id: string;
  project_id: string;
  item_id: string;
  canonical_key: string;
  doc_class: string;
  status: string;
  created_at: string;
};

export type UpsertCanonicalDocInput = {
  project_id: string;
  canonical_key: string;
  doc_class: string;
  title: string;
  kind: string;
  scope: string;
  pinned?: boolean | null;
  status?: string | null;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
};

export async function upsertCanonicalDoc(
  client: DbClient,
  input: UpsertCanonicalDocInput
): Promise<{ item: MemoryItemRow; canonical: CanonicalDocRow }>{
  if (!input.project_id) {
    throw new ValidationError("project_id is required");
  }
  if (!input.canonical_key) {
    throw new ValidationError("canonical_key is required");
  }

  const item = await upsertMemoryItem(client, {
    project_id: input.project_id,
    canonical_key: input.canonical_key,
    scope: input.scope,
    kind: input.kind,
    doc_class: input.doc_class,
    title: input.title,
    pinned: input.pinned ?? true,
    tags: input.tags ?? null,
    metadata: input.metadata ?? null,
    status: input.status ?? "active",
  });

  const status = input.status ?? "active";
  const result = await client.query(
    `INSERT INTO canonical_docs (project_id, item_id, canonical_key, doc_class, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (project_id, canonical_key)
     DO UPDATE SET item_id = EXCLUDED.item_id, doc_class = EXCLUDED.doc_class, status = EXCLUDED.status
     RETURNING id, project_id, item_id, canonical_key, doc_class, status, created_at`,
    [input.project_id, item.id, input.canonical_key, input.doc_class, status]
  );

  return { item, canonical: result.rows[0] };
}

export async function getCanonicalDocByKey(
  client: DbClient,
  projectId: string,
  canonicalKey: string
): Promise<CanonicalDocRow | null> {
  const scoped = applyProjectScope(
    {
      text: "SELECT id, project_id, item_id, canonical_key, doc_class, status, created_at FROM canonical_docs WHERE canonical_key = $1 AND {{project_scope}}",
      values: [canonicalKey],
    },
    projectId,
    "project_id"
  );

  const result = await client.query(scoped);
  return result.rows[0] ?? null;
}

export async function requireCanonicalDocByKey(
  client: DbClient,
  projectId: string,
  canonicalKey: string
): Promise<CanonicalDocRow> {
  const doc = await getCanonicalDocByKey(client, projectId, canonicalKey);
  if (!doc) {
    throw new NotFoundError("Canonical doc not found", { canonical_key: canonicalKey });
  }
  return doc;
}
