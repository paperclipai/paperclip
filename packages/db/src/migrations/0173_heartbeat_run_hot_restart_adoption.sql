ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "process_start_ticks" bigint;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "lifecycle_state" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "adoption_marked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "adoption_downtime_ms" bigint DEFAULT 0 NOT NULL;
