CREATE TABLE IF NOT EXISTS sandbox_environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID REFERENCES agents(id),
  provider TEXT NOT NULL DEFAULT 'e2b',
  sandbox_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  region TEXT DEFAULT 'us-east-1',
  template TEXT,
  timeout_seconds INTEGER NOT NULL DEFAULT 300,
  cpu_millicores INTEGER NOT NULL DEFAULT 1000,
  memory_mb INTEGER NOT NULL DEFAULT 512,
  disk_mb INTEGER NOT NULL DEFAULT 1024,
  ports JSONB DEFAULT '[]',
  env_vars JSONB DEFAULT '{}',
  sandbox_url TEXT,
  terminal_url TEXT,
  logs_url TEXT,
  started_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  error_message TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sandbox_env_company ON sandbox_environments(company_id);
CREATE INDEX idx_sandbox_env_agent ON sandbox_environments(agent_id);
CREATE INDEX idx_sandbox_env_status ON sandbox_environments(status);

ALTER TABLE agents ADD COLUMN IF NOT EXISTS sandbox_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS sandbox_provider TEXT DEFAULT 'local';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS sandbox_template TEXT;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS sandbox_timeout_seconds INTEGER NOT NULL DEFAULT 300;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS sandbox_auto_start BOOLEAN NOT NULL DEFAULT false;
