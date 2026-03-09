CREATE TABLE IF NOT EXISTS "plugin_logs" (
  "id" serial PRIMARY KEY,
  "plugin_id" uuid NOT NULL REFERENCES "plugins"("id") ON DELETE CASCADE,
  "level" text NOT NULL DEFAULT 'info',
  "message" text NOT NULL,
  "meta" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "plugin_logs_plugin_time_idx" ON "plugin_logs" ("plugin_id", "created_at");
CREATE INDEX IF NOT EXISTS "plugin_logs_level_idx" ON "plugin_logs" ("level");
