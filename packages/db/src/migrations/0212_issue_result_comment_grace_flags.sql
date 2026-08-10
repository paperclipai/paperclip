-- §9.2 result-comment grace (SAG-3385)
-- One row per (company, source_issue, run) strand that was given a disposition-flush continuation.
-- The unique constraint on (company_id, source_issue_id, run_id) is the idempotency guard —
-- a second stranded scan for the same strand attempts an insert and sees a conflict, signalling
-- that grace was already given and normal §9.2 recovery should proceed.
CREATE TABLE "issue_result_comment_grace_flags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "source_issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "run_id" uuid NOT NULL,
  "result_comment_id" uuid NOT NULL,
  "queued_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX "issue_result_comment_grace_flags_strand_uq"
  ON "issue_result_comment_grace_flags" ("company_id", "source_issue_id", "run_id");
