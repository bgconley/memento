-- 0002_tenancy.sql

CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  repo_url TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active|archived
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, project_key)
);

CREATE INDEX projects_workspace_idx ON projects(workspace_id);
