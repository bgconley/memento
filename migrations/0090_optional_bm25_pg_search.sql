-- 0090_optional_bm25_pg_search.sql
-- Optional migration: install BM25 extension (provider-specific).
-- This file is NOT safe to run everywhere because it depends on your Postgres distribution.

-- ParadeDB pg_search (BM25):
-- https://github.com/paradedb/paradedb (installation required)

CREATE EXTENSION IF NOT EXISTS pg_search;

CREATE INDEX IF NOT EXISTS idx_chunks_bm25
  ON memory_chunks
  USING bm25 (
    id,
    chunk_text::pdb.simple('stemmer=english')
  )
  WITH (key_field = 'id');

-- If you do not install pg_search, the app MUST fall back to:
-- - Postgres full text search (tsvector + ts_rank_cd)
-- - pg_trgm for identifier / fuzzy token recall
