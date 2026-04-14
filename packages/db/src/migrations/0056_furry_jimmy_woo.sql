ALTER TABLE "heartbeat_runs" ADD COLUMN "low_memory_retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "scheduled_at" timestamp with time zone;