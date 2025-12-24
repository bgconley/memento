import type { DbClient } from "../db";
import { ConflictError, NotFoundError } from "../db";

export type WorkspaceRow = {
  id: string;
  name: string;
  created_at: string;
};

export async function getWorkspaceByName(client: DbClient, name: string): Promise<WorkspaceRow | null> {
  const result = await client.query(
    "SELECT id, name, created_at FROM workspaces WHERE name = $1",
    [name]
  );

  return result.rows[0] ?? null;
}

export async function getWorkspaceById(client: DbClient, id: string): Promise<WorkspaceRow | null> {
  const result = await client.query(
    "SELECT id, name, created_at FROM workspaces WHERE id = $1",
    [id]
  );

  return result.rows[0] ?? null;
}

export async function createWorkspace(client: DbClient, name: string): Promise<WorkspaceRow> {
  try {
    const result = await client.query(
      "INSERT INTO workspaces (name) VALUES ($1) RETURNING id, name, created_at",
      [name]
    );

    return result.rows[0];
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as { code?: string }).code === "23505") {
      throw new ConflictError("Workspace already exists", { name });
    }
    throw err;
  }
}

export async function getOrCreateWorkspace(client: DbClient, name: string): Promise<WorkspaceRow> {
  const existing = await getWorkspaceByName(client, name);
  if (existing) return existing;
  return createWorkspace(client, name);
}

export async function listWorkspaces(
  client: DbClient,
  limit: number,
  offset: number
): Promise<WorkspaceRow[]> {
  const result = await client.query(
    "SELECT id, name, created_at FROM workspaces ORDER BY created_at DESC LIMIT $1 OFFSET $2",
    [limit, offset]
  );

  return result.rows;
}

export async function requireWorkspaceByName(client: DbClient, name: string): Promise<WorkspaceRow> {
  const workspace = await getWorkspaceByName(client, name);
  if (!workspace) {
    throw new NotFoundError("Workspace not found", { name });
  }
  return workspace;
}

export async function requireWorkspaceById(client: DbClient, id: string): Promise<WorkspaceRow> {
  const workspace = await getWorkspaceById(client, id);
  if (!workspace) {
    throw new NotFoundError("Workspace not found", { id });
  }
  return workspace;
}
