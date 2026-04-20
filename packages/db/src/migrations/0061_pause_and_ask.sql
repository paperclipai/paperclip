-- Add question_data column to issue_comments for pause-and-ask feature
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "question_data" jsonb;
