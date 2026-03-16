ALTER TABLE "heartbeat_runs" ADD COLUMN "retry_of_run_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "not_before_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_retry_of_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;