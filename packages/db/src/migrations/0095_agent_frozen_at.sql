ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "frozen_at" timestamp with time zone;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "pre_freeze_status" text;
