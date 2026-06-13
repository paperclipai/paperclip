CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_context_issue_id_idx" ON "heartbeat_runs" (company_id, (context_snapshot->>'issueId'), created_at DESC);
