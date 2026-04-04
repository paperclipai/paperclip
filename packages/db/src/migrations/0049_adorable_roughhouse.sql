CREATE UNIQUE INDEX "agent_wakeup_requests_agent_idempotency_key_idx" ON "agent_wakeup_requests" USING btree ("agent_id","idempotency_key") WHERE "status" <> 'skipped';
