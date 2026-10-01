ALTER TABLE "issues" ADD COLUMN "execution_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_agent_name_key" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_execution_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("execution_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;