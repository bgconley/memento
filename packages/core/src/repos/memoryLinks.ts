import type { DbClient } from "../db";
import { NotFoundError, ValidationError } from "../db";

export type MemoryLinkRow = {
  id: string;
  project_id: string;
  from_item_id: string;
  to_item_id: string;
  relation: string;
  weight: number;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type CreateMemoryLinkInput = {
  project_id: string;
  from_item_id: string;
  to_item_id: string;
  relation: string;
  weight?: number;
  metadata?: Record<string, unknown>;
};

export async function createMemoryLink(
  client: DbClient,
  input: CreateMemoryLinkInput
): Promise<MemoryLinkRow> {
  if (!input.project_id) {
    throw new ValidationError("project_id is required");
  }

  const weight = input.weight ?? 1.0;
  const metadata = input.metadata ?? {};

  const result = await client.query(
    `INSERT INTO memory_links (project_id, from_item_id, to_item_id, relation, weight, metadata)
     SELECT $1, from_item.id, to_item.id, $4, $5, $6
     FROM memory_items AS from_item
     JOIN memory_items AS to_item ON to_item.id = $3
     WHERE from_item.id = $2
       AND from_item.project_id = $1
       AND to_item.project_id = $1
     RETURNING id, project_id, from_item_id, to_item_id, relation, weight, metadata, created_at`,
    [
      input.project_id,
      input.from_item_id,
      input.to_item_id,
      input.relation,
      weight,
      metadata,
    ]
  );

  if (!result.rows[0]) {
    throw new NotFoundError("Memory link items not found", {
      from_item_id: input.from_item_id,
      to_item_id: input.to_item_id,
    });
  }

  return result.rows[0];
}
