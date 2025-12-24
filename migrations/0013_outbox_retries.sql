-- 0013_outbox_retries.sql

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS locked_by TEXT;

CREATE INDEX IF NOT EXISTS outbox_events_next_attempt_idx
  ON outbox_events(next_attempt_at)
  WHERE processed_at IS NULL;
