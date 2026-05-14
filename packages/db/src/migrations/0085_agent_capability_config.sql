ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "agent_capability_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "capability_config" jsonb DEFAULT '{}'::jsonb NOT NULL;
