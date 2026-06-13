-- Partial unique index to coalesce per-pool ccrotate capacity exhaustion
-- escalation issues. Only one non-terminal, non-hidden issue per
-- (company, ccrotate_target) is allowed at a time; once it's done/cancelled
-- a fresh one can be opened for the next outage. See escalateCcrotateCapacityExhausted
-- in server/src/services/recovery/service.ts.
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_ccrotate_capacity_exhaustion_uq"
  ON "issues" USING btree ("company_id", "origin_kind", "origin_id")
  WHERE "origin_kind" = 'ccrotate_capacity_exhausted'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
