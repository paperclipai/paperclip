CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_ctx_taskkey_created_idx" ON "heartbeat_runs" USING btree ("company_id", ("context_snapshot" ->> 'taskKey'), "created_at" DESC);
