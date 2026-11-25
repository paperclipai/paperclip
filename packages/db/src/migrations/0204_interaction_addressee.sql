ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "addressee_agent_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "issue_thread_interactions" ADD CONSTRAINT "issue_thread_interactions_addressee_agent_id_agents_id_fk" FOREIGN KEY ("addressee_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_addressee_agent_idx" ON "issue_thread_interactions" USING btree ("addressee_agent_id");
