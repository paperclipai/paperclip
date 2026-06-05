-- PEN-382 follow-up: DB-enforce the ccrotate capacity-exhaustion escalation
-- dedup so a pool outage that exhausts many agents' retries concurrently can
-- only ever produce ONE open escalation issue per (company, ccrotate target),
-- matching the partial-unique-index convention used by the sibling recovery
-- escalations (see 0069_liveness_recovery_dedupe).
CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_ccrotate_capacity_exhaustion_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'ccrotate_capacity_exhausted'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
