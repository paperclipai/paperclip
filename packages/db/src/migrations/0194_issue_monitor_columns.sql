-- ALAA-3749: backfill migration for the six monitor_* columns declared on
-- issues since 261a13d (which shipped schema + 0193 for external_blocker only).
-- Freshly migrated DBs lack these columns, so any drizzle query touching
-- issues fails with 'column "monitor_next_check_at" of relation "issues"
-- does not exist'. The live control-plane DB already has them (added
-- out-of-band), so every statement is IF NOT EXISTS: a no-op there, the
-- missing DDL on fresh rebuilds.
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_next_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_wake_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_last_triggered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_notes" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "monitor_scheduled_by" text;
