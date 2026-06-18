ALTER TABLE "heartbeat_runs" ADD COLUMN "last_output_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "max_runtime_sec" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "spawn_command" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "task_type" text;