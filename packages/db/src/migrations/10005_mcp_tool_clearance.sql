-- NEO-446: Phase 1 — requester-clearance dimension + MIN(agent,requester) gate + audit attribution
-- Adds tool clearance columns to agent_mcp_servers and user-attribution columns to mcp_server_audit_log.

ALTER TABLE agent_mcp_servers
  ADD COLUMN IF NOT EXISTS binding_authority text NOT NULL DEFAULT 'board',
  ADD COLUMN IF NOT EXISTS tool_clearances jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS default_min_user_role text NOT NULL DEFAULT 'board',
  ADD COLUMN IF NOT EXISTS autonomous_allowed boolean NOT NULL DEFAULT false;

ALTER TABLE mcp_server_audit_log
  ADD COLUMN IF NOT EXISTS on_behalf_of_user_id text,
  ADD COLUMN IF NOT EXISTS on_behalf_of_role text,
  ADD COLUMN IF NOT EXISTS decision text,
  ADD COLUMN IF NOT EXISTS args_digest text,
  ADD COLUMN IF NOT EXISTS result_digest text;
