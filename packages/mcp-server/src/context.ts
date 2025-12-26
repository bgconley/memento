import { AsyncLocalStorage } from "node:async_hooks";
import { ValidationError } from "@memento/core";

export type RequestContext = {
  workspaceId?: string;
  projectId?: string;
};

const contextStorage = new AsyncLocalStorage<RequestContext>();

export function createRequestContext(): RequestContext {
  return {};
}

export function runWithContext<T>(base: RequestContext, fn: () => Promise<T>): Promise<T> {
  const snapshot = { ...base };
  return contextStorage.run(snapshot, fn);
}

function getActiveContext(base: RequestContext): RequestContext {
  return contextStorage.getStore() ?? base;
}

export function setActiveProject(
  context: RequestContext,
  workspaceId: string,
  projectId: string
): void {
  context.workspaceId = workspaceId;
  context.projectId = projectId;
  const store = contextStorage.getStore();
  if (store) {
    store.workspaceId = workspaceId;
    store.projectId = projectId;
  }
}

export function resolveWorkspaceId(
  context: RequestContext,
  workspaceId?: string
): string {
  const active = getActiveContext(context);
  const resolved = workspaceId ?? active.workspaceId;
  if (!resolved) {
    throw new ValidationError("workspace_id is required");
  }
  return resolved;
}

export function resolveProjectId(
  context: RequestContext,
  projectId?: string
): string {
  const active = getActiveContext(context);
  const resolved = projectId ?? active.projectId;
  if (!resolved) {
    throw new ValidationError("project_id is required");
  }
  return resolved;
}
