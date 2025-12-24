-- 0010_outbox_leases.sql

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS processing_expires_at TIMESTAMPTZ;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS outbox_events_processing_idx
  ON outbox_events(processing_expires_at)
  WHERE processed_at IS NULL;
