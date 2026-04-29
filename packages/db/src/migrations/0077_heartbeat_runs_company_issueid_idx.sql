-- Hot path: locating heartbeat_runs rows by (company_id, contextSnapshot->>'issueId').
-- Several issue-scoped queries (server/src/services/{routines,activity,recovery/service,
-- issue-tree-control,plugin-host-services,heartbeat,issues}.ts) join or filter on this
-- expression. Without an index Postgres falls back to a Seq Scan over heartbeat_runs,
-- which becomes the dominant cost as the table grows.
--
-- Partial index: only rows that actually carry an issueId are useful for these lookups,
-- and excluding NULLs keeps the index small (most automation/non-issue runs are skipped).
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_issueid_idx"
  ON "heartbeat_runs" ("company_id", (("context_snapshot" ->> 'issueId')))
  WHERE ("context_snapshot" ->> 'issueId') IS NOT NULL;
