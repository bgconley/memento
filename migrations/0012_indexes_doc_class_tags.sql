-- 0012_indexes_doc_class_tags.sql
-- High-value indexes for doc_class and tag filtering.

ALTER TABLE memory_items ADD COLUMN IF NOT EXISTS doc_class TEXT;

CREATE INDEX IF NOT EXISTS memory_items_tags_gin
  ON memory_items USING GIN (tags);

CREATE INDEX IF NOT EXISTS memory_items_project_doc_class_idx
  ON memory_items (project_id, doc_class);
