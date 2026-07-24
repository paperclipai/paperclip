ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "evaluator_id" text;
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "evaluator_contract_version" text;
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "evaluation_outcome" text;
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "evaluation_result" jsonb;
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "evaluator_provenance" jsonb;
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "exception_fingerprint" text;
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "evidence_digest" text;
ALTER TABLE "routine_runs" ADD COLUMN IF NOT EXISTS "evaluation_lease_expires_at" timestamp with time zone;
CREATE INDEX IF NOT EXISTS "routine_runs_evaluator_outcome_idx"
  ON "routine_runs" USING btree ("evaluator_id", "evaluation_outcome", "created_at");
CREATE INDEX IF NOT EXISTS "routine_runs_exception_fingerprint_idx"
  ON "routine_runs" USING btree ("routine_id", "exception_fingerprint");

CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_exception_uq"
  ON "issues" USING btree ("company_id", "origin_kind", "origin_id", "origin_fingerprint")
  WHERE "origin_kind" = 'routine_exception'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
