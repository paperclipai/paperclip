ALTER TABLE "heartbeat_runs" ADD COLUMN "process_start_ticks" bigint;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "hot_restart_adoption_state" text;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "hot_restart_adoption_attempted_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "hot_restart_adopted_at" timestamp with time zone;
