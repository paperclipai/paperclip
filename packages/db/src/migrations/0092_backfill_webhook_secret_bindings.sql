-- Backfill secret bindings for legacy webhook routine_triggers.
--
-- Background: services/secrets.ts:assertBindingContext enforces that every
-- secret resolved with consumerType="routine" has a matching row in
-- company_secret_bindings keyed by
--   (company_id, secret_id, target_type='routine',
--    target_id=routine_id::text,
--    config_path='webhookSecret:'||secret_id::text).
-- services/routines.ts inserts that binding when minting a new webhook trigger,
-- but instances that predate the binding-enforcement release have webhook
-- triggers without bindings — their stored secret value still exists but the
-- dispatch path returns HTTP 422 binding_missing, breaking every legacy
-- webhook trigger after upgrade.
--
-- This migration inserts the missing binding rows for every enabled webhook
-- trigger that references a secret. Idempotent: the NOT EXISTS guard plus the
-- ON CONFLICT clause on the (company_id, target_type, target_id, config_path)
-- unique index make re-runs a no-op (0 rows inserted).
INSERT INTO "company_secret_bindings" (
  "company_id",
  "secret_id",
  "target_type",
  "target_id",
  "config_path"
)
SELECT
  t."company_id",
  t."secret_id",
  'routine',
  t."routine_id"::text,
  'webhookSecret:' || t."secret_id"::text
FROM "routine_triggers" t
WHERE t."kind" = 'webhook'
  AND t."enabled" = true
  AND t."secret_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "company_secret_bindings" b
    WHERE b."secret_id" = t."secret_id"
      AND b."target_type" = 'routine'
      AND b."target_id" = t."routine_id"::text
      AND b."config_path" = 'webhookSecret:' || t."secret_id"::text
  )
ON CONFLICT ("company_id", "target_type", "target_id", "config_path") DO NOTHING;
