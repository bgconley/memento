-- 0009_triggers.sql
-- Robustness triggers:
-- - updated_at auto-maintenance
-- - project_id propagation to versions/chunks/embeddings
-- - cross-table consistency checks (project_id match)

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memory_items_updated_at ON memory_items;
CREATE TRIGGER trg_memory_items_updated_at
BEFORE UPDATE ON memory_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- project_id propagation for memory_versions (derive from memory_items)
CREATE OR REPLACE FUNCTION trg_set_project_id_versions()
RETURNS trigger AS $$
DECLARE
  pid UUID;
BEGIN
  SELECT project_id INTO pid FROM memory_items WHERE id = NEW.item_id;
  IF pid IS NULL THEN
    RAISE EXCEPTION 'memory_versions.item_id % not found', NEW.item_id;
  END IF;
  NEW.project_id := pid;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memory_versions_project_id ON memory_versions;
CREATE TRIGGER trg_memory_versions_project_id
BEFORE INSERT ON memory_versions
FOR EACH ROW EXECUTE FUNCTION trg_set_project_id_versions();

-- project_id propagation for memory_chunks (derive from memory_versions)
CREATE OR REPLACE FUNCTION trg_set_project_id_chunks()
RETURNS trigger AS $$
DECLARE
  pid UUID;
BEGIN
  SELECT project_id INTO pid FROM memory_versions WHERE id = NEW.version_id;
  IF pid IS NULL THEN
    RAISE EXCEPTION 'memory_chunks.version_id % not found', NEW.version_id;
  END IF;
  NEW.project_id := pid;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_memory_chunks_project_id ON memory_chunks;
CREATE TRIGGER trg_memory_chunks_project_id
BEFORE INSERT ON memory_chunks
FOR EACH ROW EXECUTE FUNCTION trg_set_project_id_chunks();

-- project_id propagation & validation for chunk_embeddings
CREATE OR REPLACE FUNCTION trg_set_project_id_chunk_embeddings()
RETURNS trigger AS $$
DECLARE
  pid_chunk UUID;
  pid_profile UUID;
BEGIN
  SELECT project_id INTO pid_chunk FROM memory_chunks WHERE id = NEW.chunk_id;
  IF pid_chunk IS NULL THEN
    RAISE EXCEPTION 'chunk_embeddings.chunk_id % not found', NEW.chunk_id;
  END IF;

  SELECT project_id INTO pid_profile FROM embedding_profiles WHERE id = NEW.embedding_profile_id;
  IF pid_profile IS NULL THEN
    RAISE EXCEPTION 'chunk_embeddings.embedding_profile_id % not found', NEW.embedding_profile_id;
  END IF;

  IF pid_chunk <> pid_profile THEN
    RAISE EXCEPTION 'project mismatch: chunk % belongs to %, profile % belongs to %',
      NEW.chunk_id, pid_chunk, NEW.embedding_profile_id, pid_profile;
  END IF;

  NEW.project_id := pid_chunk;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chunk_embeddings_project_id ON chunk_embeddings;
CREATE TRIGGER trg_chunk_embeddings_project_id
BEFORE INSERT ON chunk_embeddings
FOR EACH ROW EXECUTE FUNCTION trg_set_project_id_chunk_embeddings();

-- canonical_docs consistency check: item project must match canonical_docs.project_id
CREATE OR REPLACE FUNCTION trg_validate_canonical_docs_project()
RETURNS trigger AS $$
DECLARE
  pid_item UUID;
BEGIN
  SELECT project_id INTO pid_item FROM memory_items WHERE id = NEW.item_id;
  IF pid_item IS NULL THEN
    RAISE EXCEPTION 'canonical_docs.item_id % not found', NEW.item_id;
  END IF;

  IF pid_item <> NEW.project_id THEN
    RAISE EXCEPTION 'canonical_docs project mismatch: item % belongs to %, canonical_docs has %',
      NEW.item_id, pid_item, NEW.project_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_canonical_docs_project ON canonical_docs;
CREATE TRIGGER trg_canonical_docs_project
BEFORE INSERT OR UPDATE ON canonical_docs
FOR EACH ROW EXECUTE FUNCTION trg_validate_canonical_docs_project();
