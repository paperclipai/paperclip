-- getLatestIssueRun / getLatestIssueRunForAgent filter on context_snapshot->>'issueId',
-- which forced a seq scan detoasting every row (4.7s/query on a 3.8GB table in prod,
-- saturating the connection pool and starving /api/health). Expression index makes the
-- latest-run-for-issue lookup an index scan (<1ms).
-- IF NOT EXISTS: this index was applied out-of-band on prod (2026-07-19) to restore readiness.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_issue_created_idx"
  ON "heartbeat_runs" ("company_id", ("context_snapshot"->>'issueId'), "created_at" DESC, "id" DESC);
