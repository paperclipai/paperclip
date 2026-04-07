CREATE TABLE IF NOT EXISTS agent_prompt_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id),
  version_number INTEGER NOT NULL,
  system_prompt TEXT,
  agent_instructions TEXT,
  changed_by_user_id TEXT,
  change_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_prompt_versions_agent_idx ON agent_prompt_versions(agent_id, version_number DESC);
