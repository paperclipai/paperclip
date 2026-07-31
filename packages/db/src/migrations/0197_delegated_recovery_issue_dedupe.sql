CREATE UNIQUE INDEX IF NOT EXISTS "issues_delegated_recovery_fingerprint_uq"
  ON "issues" USING btree ("company_id", "origin_kind", "origin_fingerprint")
  WHERE "origin_kind" = 'delegated_recovery'
    AND "origin_fingerprint" <> 'default'
    AND "hidden_at" IS NULL;
