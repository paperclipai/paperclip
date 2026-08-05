ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "restoration_fingerprint" text;
ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "restoration_verification_pending" boolean DEFAULT false NOT NULL;
ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "restoration_attempt_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "restoration_attempts" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "restoration_escalated_at" timestamp with time zone;
