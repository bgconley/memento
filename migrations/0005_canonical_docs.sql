-- 0005_canonical_docs.sql

CREATE TABLE canonical_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  doc_class TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active|superseded|archived
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, canonical_key),
  UNIQUE (item_id)
);

CREATE INDEX canonical_docs_project_idx ON canonical_docs(project_id, canonical_key);
