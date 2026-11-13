ALTER TABLE "status_cards" ADD COLUMN IF NOT EXISTS "mentioned_issue_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
