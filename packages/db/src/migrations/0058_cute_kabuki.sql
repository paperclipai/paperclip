ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "workspace_config" jsonb DEFAULT '{}'::jsonb NOT NULL;
