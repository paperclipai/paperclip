ALTER TABLE deployments ADD COLUMN IF NOT EXISTS cloud_provider TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS cloud_region TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS cloud_resource_id TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS cloud_resource_type TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS cloud_config JSONB DEFAULT '{}';
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS health_status TEXT DEFAULT 'unknown';
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS health_checked_at TIMESTAMPTZ;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS health_message TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS rollback_deployment_id UUID REFERENCES deployments(id);
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS version TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS commit_sha TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS docker_image TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS domain TEXT;
ALTER TABLE deployments ADD COLUMN IF NOT EXISTS ssl_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS deployment_health_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES deployments(id),
  company_id UUID NOT NULL REFERENCES companies(id),
  status TEXT NOT NULL DEFAULT 'unknown',
  response_time_ms INTEGER,
  status_code INTEGER,
  message TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deployment_health_checks_deployment ON deployment_health_checks(deployment_id);
CREATE INDEX idx_deployment_health_checks_company ON deployment_health_checks(company_id);

CREATE TABLE IF NOT EXISTS deployment_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL,
  description TEXT,
  cloud_provider TEXT NOT NULL,
  cloud_region TEXT NOT NULL DEFAULT 'us-east-1',
  resource_type TEXT NOT NULL,
  config_template JSONB NOT NULL DEFAULT '{}',
  env_template JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deployment_recipes_company ON deployment_recipes(company_id);
