-- Expression indexes for JSONB fields queried in heartbeat reconciliation.
-- These eliminate sequential scans on heartbeat_runs and agent_wakeup_requests
-- when filtering by issueId — critical for large multi-tenant installs.
--
-- NOTE: CONCURRENTLY cannot run inside a transaction block. These are applied
-- outside any wrapping transaction so they do not lock the tables during build.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "heartbeat_runs_context_issue_id_idx"
  ON "heartbeat_runs" (("context_snapshot" ->> 'issueId'))
  WHERE ("context_snapshot" ->> 'issueId') IS NOT NULL;
--> statement-breakpoint

CREATE INDEX CONCURRENTLY IF NOT EXISTS "agent_wakeup_requests_payload_issue_id_idx"
  ON "agent_wakeup_requests" (("payload" ->> 'issueId'))
  WHERE ("payload" ->> 'issueId') IS NOT NULL;
