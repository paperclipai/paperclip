ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "last_observed_stop_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "issue_watchdogs" ADD COLUMN IF NOT EXISTS "last_reviewed_stop_snapshot" jsonb;
