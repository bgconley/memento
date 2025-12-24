-- 0014_outbox_lease_expiry.sql

ALTER TABLE outbox_events
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS outbox_events_lease_idx
  ON outbox_events(lease_expires_at)
  WHERE processed_at IS NULL;
