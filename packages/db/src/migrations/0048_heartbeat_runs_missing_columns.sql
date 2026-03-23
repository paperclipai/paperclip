ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_fetch_mode" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "normalized_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "prompt_chars" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "session_reused" boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "skill_set_hash" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "task_session_reused" boolean NOT NULL DEFAULT false;
