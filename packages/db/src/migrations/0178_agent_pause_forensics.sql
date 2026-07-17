ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "pause_note" text;
ALTER TABLE "agents"
  ADD COLUMN IF NOT EXISTS "paused_by_user_id" text;
