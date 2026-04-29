-- Backfill any legacy 'cron' kind to canonical 'schedule'.
-- Background: tickScheduledTriggers filters rows with kind = 'schedule', so
-- triggers persisted with the legacy/manual 'cron' value were silently invisible
-- to the scheduler and never advanced their next_run_at / last_fired_at.
UPDATE "routine_triggers"
SET "kind" = 'schedule', "updated_at" = now()
WHERE "kind" = 'cron';
--> statement-breakpoint

-- Reset stuck next_run_at for any cron-bearing trigger that has never fired.
-- The scheduler picks them up on the next tick; skip_missed catch-up policy
-- then advances them to the next valid slot.
UPDATE "routine_triggers"
SET "next_run_at" = now(), "updated_at" = now()
WHERE "kind" = 'schedule'
  AND "enabled" = true
  AND "cron_expression" IS NOT NULL
  AND "last_fired_at" IS NULL
  AND "next_run_at" IS NOT NULL
  AND "next_run_at" < now() - interval '15 minutes';
--> statement-breakpoint

-- Enforce valid trigger kinds going forward so this corruption can't recur
-- via direct DB writes / older imports.
DO $$ BEGIN
  ALTER TABLE "routine_triggers"
    ADD CONSTRAINT "routine_triggers_kind_check"
    CHECK ("kind" IN ('schedule', 'webhook', 'api'));
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;
