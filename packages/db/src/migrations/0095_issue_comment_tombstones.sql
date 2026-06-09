ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "deleted_by_type" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "deleted_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "deleted_by_user_id" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "deleted_by_run_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_deleted_by_agent_id_agents_id_fk" FOREIGN KEY ("deleted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_deleted_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("deleted_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
