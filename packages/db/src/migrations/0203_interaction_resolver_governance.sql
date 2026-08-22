ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "interaction_resolver_governance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "requested_resolver_policy" text DEFAULT 'board_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "effective_resolver_policy" text DEFAULT 'board_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "resolved_by_run_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_resolved_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("resolved_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
