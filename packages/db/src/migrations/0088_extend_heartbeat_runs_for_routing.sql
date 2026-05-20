ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "tier_chosen" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "model_used" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "total_cost_usd" real;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "escalation_count" integer DEFAULT 0 NOT NULL;
