DROP INDEX IF EXISTS "issue_execution_decisions_reviewer_run_idempotency_uq";
DROP INDEX IF EXISTS "issue_execution_decisions_review_round_uq";
ALTER TABLE "issue_execution_decisions" DROP COLUMN IF EXISTS "payload_hash";
ALTER TABLE "issue_execution_decisions" DROP COLUMN IF EXISTS "idempotency_key";
ALTER TABLE "issue_execution_decisions" DROP COLUMN IF EXISTS "review_round_id";

