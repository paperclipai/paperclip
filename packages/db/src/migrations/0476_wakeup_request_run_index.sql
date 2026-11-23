CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_wakeup_requests_company_run_idx" ON "agent_wakeup_requests" USING btree ("company_id","run_id") WHERE "agent_wakeup_requests"."run_id" IS NOT NULL;
