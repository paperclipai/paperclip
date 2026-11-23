CREATE INDEX CONCURRENTLY IF NOT EXISTS "routine_runs_routine_history_idx" ON "routine_runs" USING btree ("routine_id","created_at","id");
