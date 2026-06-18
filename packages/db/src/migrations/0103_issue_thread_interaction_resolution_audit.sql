ALTER TABLE "issue_thread_interactions"
  ADD COLUMN IF NOT EXISTS "resolution_audit" jsonb;
