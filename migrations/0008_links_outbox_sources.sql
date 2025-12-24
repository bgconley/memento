-- 0008_links_outbox_sources.sql

CREATE TABLE memory_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_item_id UUID NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  to_item_id UUID NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX memory_links_project_from_idx
  ON memory_links(project_id, from_item_id);

CREATE INDEX memory_links_project_to_idx
  ON memory_links(project_id, to_item_id);

CREATE TABLE outbox_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,              -- INGEST_VERSION | EMBED_VERSION | REINDEX_PROFILE
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  error TEXT
);

CREATE INDEX outbox_events_unprocessed_idx
  ON outbox_events(created_at)
  WHERE processed_at IS NULL;

CREATE TABLE ingest_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  source_type TEXT NOT NULL,          -- file|dir|manual
  source_uri TEXT NOT NULL,
  doc_class TEXT,
  canonical_key TEXT,

  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_ingested_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ingest_sources_project_enabled_idx
  ON ingest_sources(project_id, enabled);
