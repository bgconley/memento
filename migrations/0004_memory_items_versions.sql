-- 0004_memory_items_versions.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_scope') THEN
    CREATE TYPE memory_scope AS ENUM ('project', 'workspace_shared', 'global');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'memory_kind') THEN
    CREATE TYPE memory_kind AS ENUM (
      'spec',
      'plan',
      'architecture',
      'decision',
      'troubleshooting',
      'runbook',
      'environment_fact',
      'session_snapshot',
      'note',
      'snippet'
    );
  END IF;
END $$;

CREATE TABLE memory_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope memory_scope NOT NULL DEFAULT 'project',
  kind memory_kind NOT NULL,

  canonical_key TEXT,            -- stable identifier for canonical docs
  doc_class TEXT,                -- e.g. app_spec, feature_spec, implementation_plan

  title TEXT NOT NULL,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'active', -- active|archived|deleted

  tags TEXT[] NOT NULL DEFAULT '{}'::text[],
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (project_id, canonical_key)
);

CREATE INDEX memory_items_project_kind_idx
  ON memory_items(project_id, kind, scope, status);

CREATE INDEX memory_items_project_pinned_idx
  ON memory_items(project_id, pinned) WHERE pinned = true;

CREATE TABLE memory_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  commit_id UUID REFERENCES commits(id) ON DELETE SET NULL,

  version_num INT NOT NULL,
  content_format TEXT NOT NULL DEFAULT 'markdown',
  content_text TEXT NOT NULL,
  content_json JSONB,
  checksum TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, version_num)
);

CREATE INDEX memory_versions_item_num_idx
  ON memory_versions(item_id, version_num DESC);

CREATE INDEX memory_versions_project_created_idx
  ON memory_versions(project_id, created_at DESC);
