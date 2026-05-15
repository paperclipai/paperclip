-- Fix slow issues-list query.
--
-- The issues list ORDER BY uses a correlated subquery on activity_log:
--   MAX(created_at) WHERE entity_type='issue' AND entity_id=issues.id AND ...
-- Without an index on entity_id alone, the planner falls back to a backward
-- scan on (company_id, created_at) and discards ~1M rows per issue, blowing
-- past the 30s statement_timeout for any non-trivial issues page load.
--
-- This index drops per-subquery cost from ~1000 to ~5, fixing /api/companies/:id/issues.
-- Verified live: query went from 30s timeout → 774ms for limit=20, 1415ms for limit=100.
CREATE INDEX IF NOT EXISTS "idx_activity_log_entity_id_created"
  ON "activity_log" USING btree ("entity_id", "created_at" DESC);
