ALTER TABLE "issue_thread_interactions" ADD COLUMN "withdrawn_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL;
ALTER TABLE "issue_thread_interactions" ADD COLUMN "withdrawn_at" timestamp with time zone;
