ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "consecutive_process_lost_count" integer DEFAULT 0 NOT NULL;
