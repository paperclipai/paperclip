-- Add a per-issue override for productivity-review snooze configuration.
-- This enables operators to suppress specific productivity-review triggers
-- (e.g. high_churn) for a bounded duration, scoped to a single source issue.
-- Useful for approval-gated issues that legitimately produce high churn
-- (e.g. Coordinator heartbeat patterns) without requiring a completed review
-- to act as a blanket 6-hour snooze.

ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "productivity_review_override" jsonb
  NOT NULL DEFAULT 'null'::jsonb;

COMMENT ON COLUMN "issues"."productivity_review_override" IS
  'JSONB override for productivity-review behavior. Supports:
   {
     "triggerSnoozes": [
       {
         "trigger": "high_churn",
         "snoozedUntil": "2026-08-05T12:00:00.000Z",
         "reason": "Approval-gate wait in progress"
       }
     ]
   }
   When a trigger in triggerSnoozes has snoozedUntil in the future,
   reconcileProductivityReviews will skip creating a review for that
   trigger on this source issue.';
