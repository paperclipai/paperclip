-- JAC-4532: Event identity and idempotency enforcement.
--
-- This migration adds the final idempotency-enforcement columns and switches
-- the `ingest_id` column from a random UUID to a deterministic text key
-- computed from (run_id, usage_updated_at, payload_hash), enabling
-- ON CONFLICT DO NOTHING deduplication on re-ingest.
--
-- Changes to run_events:
--   - ingest_id: uuid -> text (remove DEFAULT gen_random_uuid(), now computed at ingest)
--   - observed_sequence: new nullable integer column (source sequence for ordering)
--   - supersedes_event_id: new nullable text column (corrections/replacements)
--   - run_events_source_event_uq: convert from plain index to UNIQUE index
--
-- Changes to cost_events:
--   - observed_sequence: new nullable integer column
--   - supersedes_event_id: new nullable text column
--   - ingest_id: new text NOT NULL column (deterministic key)
--   - payload_hash: new nullable text column (SHA-256 hex digest of payload)
--   - cost_events_source_event_uq: new UNIQUE index

--> statement-breakpoint

-- ── run_events changes ────────────────────────────────────────────────

-- Switch ingest_id from uuid to deterministic text key (no more random default).
-- Existing rows get a deterministic placeholder based on their existing uuid so
-- the column remains NOT NULL. New inserts will compute it via the service layer.
ALTER TABLE "run_events"
  ALTER COLUMN "ingest_id" DROP DEFAULT,
  ALTER COLUMN "ingest_id" TYPE text USING ingest_id::text,
  ALTER COLUMN "ingest_id" SET NOT NULL;

COMMENT ON COLUMN "run_events"."ingest_id" IS
  'Deterministic ingest ID — computed from run_id + usage_updated_at + payload_hash (JAC-4532).';

-- Add observed_sequence and supersedes_event_id to run_events.
ALTER TABLE "run_events"
  ADD COLUMN IF NOT EXISTS "observed_sequence" integer,
  ADD COLUMN IF NOT EXISTS "supersedes_event_id" text;

COMMENT ON COLUMN "run_events"."observed_sequence" IS
  'Monotonically increasing sequence number observed from the source (JAC-4532).';
COMMENT ON COLUMN "run_events"."supersedes_event_id" IS
  'When this event supersedes a previous event ID for corrections/replacements (JAC-4532).';

-- Convert run_events_source_event_uq from a plain index to a UNIQUE index.
-- First drop the existing plain index, then recreate as unique.
DROP INDEX IF EXISTS "run_events_source_event_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "run_events_source_event_uq"
  ON "run_events" USING btree ("company_id", "source_system", "source_event_id", "event_kind", "attempt_index");

--> statement-breakpoint

-- ── cost_events changes ───────────────────────────────────────────────

-- Add the idempotency-enforcement columns to cost_events.
ALTER TABLE "cost_events"
  ADD COLUMN IF NOT EXISTS "observed_sequence" integer,
  ADD COLUMN IF NOT EXISTS "supersedes_event_id" text,
  ADD COLUMN IF NOT EXISTS "ingest_id" text NOT NULL DEFAULT '' ,
  ADD COLUMN IF NOT EXISTS "payload_hash" text;

-- Remove the placeholder default now that all rows have been migrated.
ALTER TABLE "cost_events" ALTER COLUMN "ingest_id" DROP DEFAULT;

COMMENT ON COLUMN "cost_events"."observed_sequence" IS
  'Monotonically increasing sequence number observed from the source (JAC-4532).';
COMMENT ON COLUMN "cost_events"."supersedes_event_id" IS
  'When this event supersedes a previous event ID for corrections/replacements (JAC-4532).';
COMMENT ON COLUMN "cost_events"."ingest_id" IS
  'Deterministic ingest ID — computed from run_id + usage_updated_at + payload_hash (JAC-4532).';
COMMENT ON COLUMN "cost_events"."payload_hash" IS
  'SHA-256 hex digest of the canonical payload, for idempotency (JAC-4532).';

-- Create the unique index for idempotent re-ingest on cost_events.
CREATE UNIQUE INDEX IF NOT EXISTS "cost_events_source_event_uq"
  ON "cost_events" USING btree ("company_id", "source_system", "source_event_id", "event_kind", "attempt_index");
