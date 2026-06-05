-- Fix schema drift: migration 0078 was applied from an earlier draft that was missing
-- several columns and had incorrect indexes. This migration brings the table up to date.

ALTER TABLE "workflow_handoff_bridges"
  ADD COLUMN IF NOT EXISTS "provider" text NOT NULL DEFAULT 'clickup',
  ADD COLUMN IF NOT EXISTS "close_outcome" text,
  ADD COLUMN IF NOT EXISTS "external_thread_id" text,
  ADD COLUMN IF NOT EXISTS "last_polled_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "closed_at" timestamp with time zone,
  ADD COLUMN IF NOT EXISTS "last_error" text;

-- Remove the DEFAULT now that existing rows have a value
ALTER TABLE "workflow_handoff_bridges" ALTER COLUMN "provider" DROP DEFAULT;

-- Drop old incorrect indexes / constraints
ALTER TABLE "workflow_handoff_bridges" DROP CONSTRAINT IF EXISTS "workflow_handoff_bridges_workflow_handoff_id_unique";
DROP INDEX IF EXISTS "workflow_handoff_bridges_handoff_idx";
DROP INDEX IF EXISTS "workflow_handoff_bridges_status_poll_idx";

-- Add correct partial unique index (only one active bridge per handoff)
CREATE UNIQUE INDEX IF NOT EXISTS "workflow_handoff_bridges_handoff_active_uq"
  ON "workflow_handoff_bridges" ("workflow_handoff_id")
  WHERE status IN ('pending_delivery', 'waiting_for_human');

-- Add correct composite poll index
CREATE INDEX IF NOT EXISTS "workflow_handoff_bridges_company_poll_idx"
  ON "workflow_handoff_bridges" ("company_id", "status", "next_poll_at");
