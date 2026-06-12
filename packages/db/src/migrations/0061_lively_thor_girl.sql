ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "scheduled_retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "scheduled_retry_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "scheduled_retry_reason" text;
