-- 0006_chunking.sql

CREATE TABLE memory_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES memory_versions(id) ON DELETE CASCADE,

  chunk_index INT NOT NULL,
  chunk_text TEXT NOT NULL,

  heading_path TEXT[] NOT NULL DEFAULT '{}'::text[],
  section_anchor TEXT,
  start_char INT,
  end_char INT,

  tsv TSVECTOR,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (version_id, chunk_index)
);

CREATE INDEX memory_chunks_version_idx ON memory_chunks(version_id, chunk_index);

CREATE INDEX memory_chunks_tsv_idx
  ON memory_chunks USING GIN (tsv);

CREATE INDEX memory_chunks_trgm_idx
  ON memory_chunks USING GIN (chunk_text gin_trgm_ops);

CREATE INDEX memory_chunks_project_created_idx
  ON memory_chunks(project_id, created_at DESC);
