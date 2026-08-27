ALTER TABLE "heartbeat_runs" ADD COLUMN "provider_process_pid" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "provider_process_group_id" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "provider_process_started_at" timestamp with time zone;