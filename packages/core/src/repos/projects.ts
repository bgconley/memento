import crypto from "node:crypto";
import path from "node:path";
import type { DbClient } from "../db";
import { NotFoundError, ValidationError } from "../db";

export type ProjectRow = {
  id: string;
  workspace_id: string;
  project_key: string;
  display_name: string;
  repo_url: string | null;
  status: string;
  created_at: string;
};

export type ResolveProjectInput = {
  workspace_id: string;
  repo_url?: string | null;
  cwd?: string | null;
  project_key?: string | null;
  display_name?: string | null;
  create_if_missing: boolean;
};

export type ListProjectsInput = {
  workspace_id?: string;
  include_archived: boolean;
  limit: number;
  offset: number;
};

function hashKey(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 40);
}

function deriveProjectKey(input: ResolveProjectInput): string {
  if (input.project_key) return input.project_key;
  if (input.repo_url) return hashKey(input.repo_url);
  if (input.cwd) return hashKey(input.cwd);
  throw new ValidationError("project_key, repo_url, or cwd is required");
}

function inferDisplayName(input: ResolveProjectInput, projectKey: string): string {
  if (input.display_name) return input.display_name;

  if (input.repo_url) {
    try {
      const url = new URL(input.repo_url);
      const basename = url.pathname.split("/").filter(Boolean).pop();
      if (basename) {
        return basename.replace(/\.git$/i, "");
      }
    } catch {
      return input.repo_url;
    }
  }

  if (input.cwd) {
    return path.basename(input.cwd);
  }

  return projectKey;
}

export async function getProjectByKey(
  client: DbClient,
  workspaceId: string,
  projectKey: string
): Promise<ProjectRow | null> {
  const result = await client.query(
    "SELECT id, workspace_id, project_key, display_name, repo_url, status, created_at FROM projects WHERE workspace_id = $1 AND project_key = $2",
    [workspaceId, projectKey]
  );

  return result.rows[0] ?? null;
}

export async function resolveProject(
  client: DbClient,
  input: ResolveProjectInput
): Promise<ProjectRow> {
  if (!input.workspace_id) {
    throw new ValidationError("workspace_id is required");
  }

  const projectKey = deriveProjectKey(input);
  const existing = await getProjectByKey(client, input.workspace_id, projectKey);
  if (existing) return existing;

  if (!input.create_if_missing) {
    throw new NotFoundError("Project not found", { project_key: projectKey });
  }

  const displayName = inferDisplayName(input, projectKey);
  const insertResult = await client.query(
    "INSERT INTO projects (workspace_id, project_key, display_name, repo_url) VALUES ($1, $2, $3, $4) ON CONFLICT (workspace_id, project_key) DO NOTHING RETURNING id, workspace_id, project_key, display_name, repo_url, status, created_at",
    [input.workspace_id, projectKey, displayName, input.repo_url ?? null]
  );

  if (insertResult.rows[0]) {
    return insertResult.rows[0];
  }

  const afterInsert = await getProjectByKey(client, input.workspace_id, projectKey);
  if (!afterInsert) {
    throw new NotFoundError("Project resolution failed", { project_key: projectKey });
  }

  return afterInsert;
}

export async function listProjects(client: DbClient, input: ListProjectsInput): Promise<ProjectRow[]> {
  const values: Array<string | number> = [];
  const clauses: string[] = [];

  if (input.workspace_id) {
    values.push(input.workspace_id);
    clauses.push(`workspace_id = $${values.length}`);
  }

  if (!input.include_archived) {
    clauses.push("status = 'active'");
  }

  values.push(input.limit);
  const limitIndex = values.length;
  values.push(input.offset);
  const offsetIndex = values.length;

  const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const query = `SELECT id, workspace_id, project_key, display_name, repo_url, status, created_at FROM projects ${whereClause} ORDER BY created_at DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`;

  const result = await client.query(query, values);
  return result.rows;
}
