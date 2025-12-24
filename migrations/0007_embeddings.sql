-- 0007_embeddings.sql

CREATE TABLE embedding_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  provider TEXT NOT NULL,                 -- voyage|jina|openai_compat
  model TEXT NOT NULL,
  dims INT NOT NULL,
  distance TEXT NOT NULL DEFAULT 'cosine', -- cosine|l2|ip
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  provider_config JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (project_id, name)
);

CREATE INDEX embedding_profiles_project_active_idx
  ON embedding_profiles(project_id, is_active);

-- Store embeddings dimensionlessly so a single table can support multiple dims.
-- IMPORTANT: You cannot index a plain `vector` column directly; you must create
-- expression+partial indexes that cast to vector(dims) for a subset of rows.
-- pgvector FAQ documents this pattern.
CREATE TABLE chunk_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chunk_id UUID NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  embedding_profile_id UUID NOT NULL REFERENCES embedding_profiles(id) ON DELETE CASCADE,

  embedding VECTOR,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (chunk_id, embedding_profile_id)
);

CREATE INDEX chunk_embeddings_project_profile_idx
  ON chunk_embeddings(project_id, embedding_profile_id);

-- NOTE: vector ANN indexes must be created per embedding_profile_id and dims:
-- Example (for dims=1024):
-- CREATE INDEX CONCURRENTLY chunk_embeddings_hnsw_<profile_id>
--   ON chunk_embeddings USING hnsw ((embedding::vector(1024)) vector_cosine_ops)
--   WHERE embedding_profile_id = '<profile_uuid>';
