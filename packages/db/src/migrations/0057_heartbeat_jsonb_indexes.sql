-- Expression indexes for JSONB fields queried in heartbeat reconciliation.
-- These eliminate sequential scans on heartbeat_runs and agent_wakeup_requests
-- when filtering by issueId — critical for large multi-tenant installs.

CREATE INDEX IF NOT EXISTS "heartbeat_runs_context_issue_id_idx"
  ON "heartbeat_runs" (("context_snapshot" ->> 'issueId'))
  WHERE ("context_snapshot" ->> 'issueId') IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_payload_issue_id_idx"
  ON "agent_wakeup_requests" (("payload" ->> 'issueId'))
  WHERE ("payload" ->> 'issueId') IS NOT NULL;
