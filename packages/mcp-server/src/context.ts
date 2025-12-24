import { ValidationError } from "@memento/core";

export type RequestContext = {
  workspaceId?: string;
  projectId?: string;
};

export function createRequestContext(): RequestContext {
  return {};
}

export function setActiveProject(
  context: RequestContext,
  workspaceId: string,
  projectId: string
): void {
  context.workspaceId = workspaceId;
  context.projectId = projectId;
}

export function resolveWorkspaceId(
  context: RequestContext,
  workspaceId?: string
): string {
  const resolved = workspaceId ?? context.workspaceId;
  if (!resolved) {
    throw new ValidationError("workspace_id is required");
  }
  return resolved;
}

export function resolveProjectId(
  context: RequestContext,
  projectId?: string
): string {
  const resolved = projectId ?? context.projectId;
  if (!resolved) {
    throw new ValidationError("project_id is required");
  }
  return resolved;
}
