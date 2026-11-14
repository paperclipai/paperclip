CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_queued_created_idx" ON "heartbeat_runs" USING btree ("company_id","created_at","id") WHERE "heartbeat_runs"."status" = 'queued';
