ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "feature_settings" jsonb;
--> statement-breakpoint
-- Backfill: lift any non-env-binding values from projects.env into feature_settings.
-- A valid env binding is either a plain string or an object with type = 'plain'|'secret_ref'.
-- Anything else (e.g. productivityReview: { holdHours, ... }) is a feature-settings entry
-- that was written into the wrong column and breaks heartbeat env-binding validation.
DO $$
BEGIN
  UPDATE "projects"
  SET
    "feature_settings" = COALESCE("feature_settings", '{}'::jsonb) || (
      SELECT COALESCE(
        jsonb_object_agg(key, value),
        '{}'::jsonb
      )
      FROM jsonb_each("env") AS t(key, value)
      WHERE jsonb_typeof(value) = 'object'
        AND NOT (value ? 'type' AND value->>'type' IN ('plain', 'secret_ref'))
    ),
    "env" = (
      SELECT COALESCE(
        jsonb_object_agg(key, value),
        '{}'::jsonb
      )
      FROM jsonb_each("env") AS t(key, value)
      WHERE jsonb_typeof(value) = 'string'
        OR (value ? 'type' AND value->>'type' IN ('plain', 'secret_ref'))
    )
  WHERE "env" IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM jsonb_each("env") AS t(key, value)
      WHERE jsonb_typeof(value) = 'object'
        AND NOT (value ? 'type' AND value->>'type' IN ('plain', 'secret_ref'))
    );
END $$;
