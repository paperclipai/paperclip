ALTER TABLE "activity_log"
  ADD COLUMN IF NOT EXISTS "responsible_user_id" text;

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because this forward-only index is required for the new agent audit feed.
CREATE INDEX IF NOT EXISTS "activity_log_company_agent_created_idx"
  ON "activity_log" USING btree ("company_id", "agent_id", "created_at");

-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable because this forward-only index is required for the new responsible-user audit feed.
CREATE INDEX IF NOT EXISTS "activity_log_company_responsible_user_created_idx"
  ON "activity_log" USING btree ("company_id", "responsible_user_id", "created_at");
