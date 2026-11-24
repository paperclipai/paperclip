-- paperclip:migration-compat online_compatible: inserts only company_secret_bindings rows of the shape the previous release already writes for every new webhook trigger and already reads on dispatch; no DDL, ON CONFLICT DO NOTHING, and the row count is bounded by the number of legacy webhook triggers, so no long lock is held.
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
  AND t."secret_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "company_secret_bindings" b
    WHERE b."company_id" = t."company_id"
      AND b."secret_id" = t."secret_id"
      AND b."target_type" = 'routine'
      AND b."target_id" = t."routine_id"::text
      AND b."config_path" = 'webhookSecret:' || t."secret_id"::text
  )
ON CONFLICT ("company_id", "target_type", "target_id", "config_path") DO NOTHING;
