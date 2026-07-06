-- Add metadata JSONB column to goals table so plugins can persist
-- free-form goal metadata through the existing goals.update path.
ALTER TABLE "goals" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
