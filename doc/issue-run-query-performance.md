# Issue run lookup

The task run list and its liveness backfill select run IDs with a UNION of
context links and company-scoped issue activity links. Each branch can use
existing indexes. The outer query still enforces company scope and sorts runs
by creation time. Duplicate activity links do not duplicate runs.

Avoid a correlated `OR EXISTS` over `heartbeat_runs`: PostgreSQL can scan the
whole company and read large context snapshots to return a single task's runs.
No schema change or additional index is required.

Validate with `server/src/__tests__/activity-service.test.ts`. It covers both
link sources, duplicate links, ordering, unrelated runs, and company boundaries.
Compare `EXPLAIN (ANALYZE, BUFFERS)` on representative histories when changing
the predicate. Query timing alone is not a whole-page performance measurement.
