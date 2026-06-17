CREATE UNIQUE INDEX IF NOT EXISTS "plugin_webhook_deliveries_external_id_unique"
  ON "plugin_webhook_deliveries" ("plugin_id", "webhook_key", "external_id")
  WHERE "external_id" IS NOT NULL;
