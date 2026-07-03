-- NEO-354: MCP server governance — allowlist/quarantine/audit + risk classification
-- Adds governance state machine columns to mcp_servers and creates the audit log table.

ALTER TABLE mcp_servers
  ADD COLUMN IF NOT EXISTS governance_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS risk_factors jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS governance_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS governance_updated_by text,
  ADD COLUMN IF NOT EXISTS governance_reason text;

CREATE TABLE IF NOT EXISTS mcp_server_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id),
  mcp_server_id uuid REFERENCES mcp_servers(id) ON DELETE SET NULL,
  server_slug text NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  risk_level text,
  tool_name text,
  actor_type text NOT NULL,
  actor_id text,
  reason text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mcp_server_audit_log_company_idx ON mcp_server_audit_log(company_id);
CREATE INDEX IF NOT EXISTS mcp_server_audit_log_server_idx ON mcp_server_audit_log(mcp_server_id);
CREATE INDEX IF NOT EXISTS mcp_server_audit_log_company_created_idx ON mcp_server_audit_log(company_id, created_at);
