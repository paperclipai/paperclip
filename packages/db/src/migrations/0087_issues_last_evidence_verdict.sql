-- BLO-4824 / BLO-4461: artifact-evidence gate Phase-1 telemetry column.
--
-- Stores the most recent verdict from services/issues.ts evidence-gate
-- evaluation, written on transitions to in_review. Phase 1 is warn-only
-- (verdict recorded but never blocks the PATCH). Phase 2 (BLO-4828) flips
-- block verdicts to 422 unprocessable. Nullable; populated lazily on the
-- first in_review transition under the gate.
ALTER TABLE "issues" ADD COLUMN "last_evidence_verdict" jsonb;
