-- Add missing indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_company_status ON heartbeat_runs (company_id, status);
CREATE INDEX IF NOT EXISTS idx_heartbeat_runs_agent_status ON heartbeat_runs (agent_id, status);
CREATE INDEX IF NOT EXISTS idx_goals_parent_id ON goals (parent_id);
CREATE INDEX IF NOT EXISTS idx_approvals_requested_by_agent ON approvals (requested_by_agent_id) WHERE requested_by_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_artifacts_run_id ON artifacts (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments (company_id, status);
CREATE INDEX IF NOT EXISTS idx_deployments_agent ON deployments (agent_id) WHERE agent_id IS NOT NULL;
