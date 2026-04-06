CREATE TABLE IF NOT EXISTS artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    issue_id UUID REFERENCES issues(id),
    run_id UUID REFERENCES heartbeat_runs(id),
    kind TEXT NOT NULL DEFAULT 'attachment',
    title TEXT NOT NULL,
    description TEXT,
    url TEXT,
    file_path TEXT,
    mime_type TEXT,
    size_bytes BIGINT,
    preview_url TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id),
    project_id UUID REFERENCES projects(id),
    agent_id UUID REFERENCES agents(id),
    run_id UUID REFERENCES heartbeat_runs(id),
    environment TEXT NOT NULL DEFAULT 'staging',
    status TEXT NOT NULL DEFAULT 'pending',
    url TEXT,
    provider TEXT,
    deploy_log TEXT,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_artifacts_company ON artifacts(company_id);
CREATE INDEX idx_artifacts_issue ON artifacts(issue_id);
CREATE INDEX idx_deployments_company ON deployments(company_id);
CREATE INDEX idx_deployments_project ON deployments(project_id);
