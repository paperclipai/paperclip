ALTER TABLE "heartbeat_runs" ADD COLUMN "process_started_at_epoch_ms" bigint;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "process_executable_path" text;