import type { QueryConfig } from "pg";
import { ValidationError } from "./errors";

const PROJECT_SCOPE_TOKEN = "{{project_scope}}";

export function applyProjectScope<T extends QueryConfig>(
  query: T,
  projectId: string,
  column = "project_id"
): T {
  if (!projectId) {
    throw new ValidationError("project_id is required for scoped queries");
  }

  if (!query.text.includes(PROJECT_SCOPE_TOKEN)) {
    throw new ValidationError(
      `Scoped query missing ${PROJECT_SCOPE_TOKEN} placeholder`
    );
  }

  const values = query.values ? [...query.values] : [];
  const paramIndex = values.length + 1;
  const text = query.text.replace(PROJECT_SCOPE_TOKEN, `${column} = $${paramIndex}`);
  values.push(projectId);

  return { ...query, text, values };
}

export function scopedQuery(
  text: string,
  values: unknown[],
  projectId: string,
  column?: string
): QueryConfig {
  return applyProjectScope({ text, values }, projectId, column);
}
