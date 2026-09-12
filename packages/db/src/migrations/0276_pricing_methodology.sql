-- 0276_pricing_methodology.sql
--
-- Add `cache_write_tokens`, a nullable `rate_card_cents`, and a non-nullable
-- `pricing_methodology` flag to `cost_events`.
--
-- The motivation: pre-existing rows folded cache-creation tokens into
-- `input_tokens`, because there was no column to put them in. Any rate-card
-- figure derived for those rows is a real lower bound rather than a
-- measurement. The token split was never recorded and is not recoverable
-- (option 4 on PHA-1643 was closed — see the research doc for citations).
--
-- We refuse to invent a number. Instead, we attach an explicit
-- `pricing_methodology` flag to every row so dashboards and BI tools can tell
-- "measured from a full token breakdown" apart from "priced at input rate
-- because cache-write was folded in".
--
-- Design: nullable `rate_card_cents` + non-nullable `pricing_methodology`
-- flag + `cost_status='reported_pre_migration'` for the affected historical
-- bucket, rather than a heuristic backfill that would re-introduce the
-- original bug or an unrecoverable reprocessing of raw token splits.
--
-- `rate_card_cents` is added nullable and with no column default on purpose: a
-- nullable column carrying `DEFAULT 0` would let a future omitted-column
-- insert silently write 0 instead of NULL, reintroducing the exact "unmeasured
-- masquerading as measured" bug this migration exists to prevent.
--
-- Cutoff: `2026-07-30T00:22:00+00` — the application-code deploy that started
-- populating `cache_write_tokens` and `rate_card_cents` from real values on
-- the running server (observed server boot time). Rows created before this
-- moment carry this migration's default of 0 for `cache_write_tokens`, not a
-- measurement.
--
-- The historical backfill for pre-existing rows is a standalone script
-- (`packages/db/src/backfill-cost-event-rate-card.ts`, run via
-- `pnpm --filter @paperclipai/db backfill:cost-event-rate-card`) rather than
-- SQL in this migration, because it needs the shared rate-card/model
-- normalization logic in TypeScript. It must be run once, after this
-- migration, against any environment with pre-cutoff rows.

ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "cache_write_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "rate_card_cents" integer;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "pricing_methodology" text DEFAULT 'measured' NOT NULL;--> statement-breakpoint

-- Re-classify pre-migration-code rows: cache_write_tokens = 0 because the
-- column did not exist yet, created_at before the application deploy. These
-- rows can be given a real lower bound by the backfill script, but no
-- cache_write premium was ever applied. Mark them so dashboards can filter or
-- bucket. Idempotent: only touches rows still at the default
-- `pricing_methodology='measured'`.
UPDATE "cost_events"
SET "pricing_methodology" = 'pre_cache_write_aware'
WHERE "pricing_methodology" = 'measured'
  AND "cache_write_tokens" = 0
  AND "created_at" < '2026-07-30T00:22:00Z'::timestamptz;--> statement-breakpoint

-- Same set of rows also gets `cost_status='reported_pre_migration'` so
-- `GROUP BY cost_status` dashboards can separate "measured today" from
-- "measured at the time but using a methodology that understates cache_write".
-- 'reported_pre_migration' preserves the original "the adapter said something
-- at the time" framing; 'reported' alone would alter the historical record
-- of what the adapter wrote. Idempotent: only touches rows currently
-- `cost_status='reported'` (the value the original adapter wrote pre-fix).
UPDATE "cost_events"
SET "cost_status" = 'reported_pre_migration'
WHERE "cost_status" = 'reported'
  AND "pricing_methodology" = 'pre_cache_write_aware';--> statement-breakpoint

-- CHECK constraint enforces the three explicit values from the HYBRID design.
-- `unpriced` is reserved for rows where even the input-rate lower bound is
-- unavailable (subscription auth with no rate-card entry for the model). It
-- is not assigned by this migration; the cost service / backfill logic
-- decides. The constraint prevents future drift if someone tries to set a
-- fourth value.
-- Postgres has no `ADD CONSTRAINT IF NOT EXISTS`; guard idempotency with a
-- catalog lookup instead so re-running this migration doesn't error.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cost_events_pricing_methodology_check'
  ) THEN
    ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_pricing_methodology_check"
      CHECK ("pricing_methodology" IN ('measured', 'pre_cache_write_aware', 'unpriced'));
  END IF;
END $$;--> statement-breakpoint

-- Backout: revert the UPDATE classifications, then drop the added columns.
-- UPDATE "cost_events"
--   SET "cost_status" = 'reported'
--   WHERE "cost_status" = 'reported_pre_migration';
-- UPDATE "cost_events"
--   SET "pricing_methodology" = 'measured'
--   WHERE "pricing_methodology" = 'pre_cache_write_aware';
-- ALTER TABLE "cost_events" DROP CONSTRAINT IF EXISTS "cost_events_pricing_methodology_check";
-- ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "pricing_methodology";
-- ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "rate_card_cents";
-- ALTER TABLE "cost_events" DROP COLUMN IF EXISTS "cache_write_tokens";
