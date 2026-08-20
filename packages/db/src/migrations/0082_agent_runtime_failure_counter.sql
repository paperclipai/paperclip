ALTER TABLE "agent_runtime_state" ADD COLUMN IF NOT EXISTS "consecutive_failure_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_runtime_state" ADD COLUMN IF NOT EXISTS "last_failure_at" timestamp with time zone;
