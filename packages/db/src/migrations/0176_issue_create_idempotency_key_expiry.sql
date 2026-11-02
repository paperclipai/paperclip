CREATE INDEX IF NOT EXISTS "issue_create_idempotency_keys_company_created_at_idx"
  ON "issue_create_idempotency_keys" USING btree ("company_id", "created_at");
