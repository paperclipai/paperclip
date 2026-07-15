ALTER TABLE "heartbeat_runs" ADD COLUMN "process_start_ticks" bigint;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "lifecycle_state" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "adoption_marked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "adoption_downtime_ms" bigint DEFAULT 0 NOT NULL;
