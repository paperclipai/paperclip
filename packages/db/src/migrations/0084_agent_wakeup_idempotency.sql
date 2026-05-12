CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_company_agent_idempotency_key_uq"
  ON "agent_wakeup_requests" USING btree ("company_id","agent_id","idempotency_key")
  WHERE "idempotency_key" IS NOT NULL AND btrim("idempotency_key") <> '';
