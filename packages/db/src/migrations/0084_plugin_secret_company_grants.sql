INSERT INTO "plugin_company_settings" (
  "company_id",
  "plugin_id",
  "enabled",
  "settings_json",
  "last_error"
)
SELECT DISTINCT
  secrets."company_id",
  plugins."id",
  true,
  '{}'::jsonb,
  NULL
FROM "company_secrets" secrets
JOIN "plugins" plugins
  ON secrets."created_by_user_id" = concat('plugin:', plugins."id"::text)
WHERE secrets."status" <> 'deleted'
ON CONFLICT ("company_id", "plugin_id") DO NOTHING;
