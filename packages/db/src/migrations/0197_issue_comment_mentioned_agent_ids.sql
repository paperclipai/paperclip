ALTER TABLE "issue_comments"
  ADD COLUMN IF NOT EXISTS "mentioned_agent_ids" jsonb;
