ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "liveness_state" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "liveness_reason" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "continuation_attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_useful_action_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "next_action" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_liveness_idx" ON "heartbeat_runs" USING btree ("company_id","liveness_state","created_at");
