-- 0015_cleanup_constraints.sql

DROP INDEX IF EXISTS outbox_events_processing_idx;

ALTER TABLE outbox_events
  DROP COLUMN IF EXISTS processing_started_at,
  DROP COLUMN IF EXISTS processing_expires_at,
  DROP COLUMN IF EXISTS attempts;

DROP TABLE IF EXISTS ingest_sources;

UPDATE memory_items
SET status = 'active'
WHERE status IS NULL
   OR status NOT IN ('active', 'archived', 'deleted');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'memory_items_status_check'
  ) THEN
    EXECUTE 'ALTER TABLE memory_items
      ADD CONSTRAINT memory_items_status_check
      CHECK (status IN (''active'', ''archived'', ''deleted''))';
  END IF;
END $$;
