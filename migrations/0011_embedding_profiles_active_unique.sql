-- 0011_embedding_profiles_active_unique.sql

WITH ranked AS (
  SELECT id,
         project_id,
         row_number() OVER (PARTITION BY project_id ORDER BY created_at DESC, id DESC) AS rn
  FROM embedding_profiles
  WHERE is_active = true
)
UPDATE embedding_profiles ep
SET is_active = false
FROM ranked r
WHERE ep.id = r.id AND r.rn > 1;

ALTER TABLE embedding_profiles
  ALTER COLUMN is_active SET DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS embedding_profiles_active_unique
  ON embedding_profiles(project_id)
  WHERE is_active = true;
