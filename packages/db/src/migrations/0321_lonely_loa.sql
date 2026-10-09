ALTER TABLE "chat_slack_manager_grants" ADD COLUMN IF NOT EXISTS "revision" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "chat_slack_manager_grants" ADD COLUMN IF NOT EXISTS "rate_limits" jsonb DEFAULT '{}'::jsonb NOT NULL;