CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_exception_uq"
  ON "issues" USING btree ("company_id", "origin_kind", "origin_id", "origin_fingerprint")
  WHERE "origin_kind" = 'routine_exception'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL
    AND "status" NOT IN ('done', 'cancelled');
