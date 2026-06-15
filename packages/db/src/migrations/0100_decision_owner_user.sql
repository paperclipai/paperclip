ALTER TABLE "issue_thread_interactions" ADD COLUMN IF NOT EXISTS "target_user_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_thread_interactions_company_target_status_idx"
  ON "issue_thread_interactions" USING btree ("company_id","target_user_id","status");
