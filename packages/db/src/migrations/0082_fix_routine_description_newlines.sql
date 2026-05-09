-- Fix literal \n sequences in routine descriptions (should be real newlines).
-- The create/update validator was missing the multilineTextSchema transform.

UPDATE "routines"
SET "description" = REPLACE(REPLACE(REPLACE("description", E'\\r' || E'\\n', E'\n'), E'\\n', E'\n'), E'\\r', E'\n'),
    "updated_at" = NOW()
WHERE "description" IS NOT NULL
  AND (position(E'\\n' in "description") > 0 OR position(E'\\r' in "description") > 0);

-- Also fix routine revision snapshots that captured the corrupted data.
UPDATE "routine_revisions"
SET "snapshot" = jsonb_set(
  "snapshot"::jsonb,
  '{routine,description}',
  to_jsonb(
    REPLACE(REPLACE(REPLACE(
      "snapshot"::jsonb->'routine'->>'description',
      E'\\r' || E'\\n', E'\n'),
      E'\\n', E'\n'),
      E'\\r', E'\n')
  )
)
WHERE "snapshot"::jsonb->'routine'->>'description' IS NOT NULL
  AND (
    position(E'\\n' in "snapshot"::jsonb->'routine'->>'description') > 0
    OR position(E'\\r' in "snapshot"::jsonb->'routine'->>'description') > 0
  );
