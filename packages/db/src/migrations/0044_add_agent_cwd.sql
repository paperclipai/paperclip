-- Add per-agent working directory.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "cwd" text;
--> statement-breakpoint
-- Backfill from legacy adapter_config.cwd values.
UPDATE "agents"
SET "cwd" = nullif(trim("adapter_config"->>'cwd'), '')
WHERE "cwd" IS NULL
  AND "adapter_config"->>'cwd' IS NOT NULL
  AND trim("adapter_config"->>'cwd') != '';
