CREATE TABLE IF NOT EXISTS "plugin_artifact_generations" (
  "generation" bigint PRIMARY KEY,
  "storage_key" text NOT NULL,
  "content_hash" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
