-- Performance indexes (WEA-1674, Carmack perf-loop run 1, WEA-1499).
-- Goal:
--   heartbeat_runs.list  p50 6,059ms -> <50ms   (120x)
--   issues.list handoff  p50   863ms -> <200ms  (worst 19s -> <200ms)
--
-- Drizzle migrator runs each migration inside a transaction, so CONCURRENTLY
-- cannot be used here. For zero-downtime rollout, ops should pre-create both
-- indexes via psql with CREATE INDEX CONCURRENTLY before the release is
-- deployed; the IF NOT EXISTS guards then make this migration a no-op.
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_company_created_idx"
--     ON "heartbeat_runs" ("company_id","created_at");
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "activity_log_company_entity_action_created_idx"
--     ON "activity_log" ("company_id","entity_type","entity_id","action","created_at");
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_created_idx" ON "heartbeat_runs" ("company_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_log_company_entity_action_created_idx" ON "activity_log" ("company_id","entity_type","entity_id","action","created_at");
