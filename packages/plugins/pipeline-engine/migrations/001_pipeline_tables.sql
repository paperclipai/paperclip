CREATE TABLE plugin_pipeline_engine_d43f8e84dd.pipeline_runs (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL,
  parent_issue_id UUID NOT NULL,
  pipeline_name TEXT NOT NULL,
  pipeline_version INTEGER NOT NULL DEFAULT 1,
  pipeline_yaml TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pe_runs_company ON plugin_pipeline_engine_d43f8e84dd.pipeline_runs(company_id);
CREATE INDEX idx_pe_runs_parent_issue ON plugin_pipeline_engine_d43f8e84dd.pipeline_runs(parent_issue_id);
CREATE INDEX idx_pe_runs_status ON plugin_pipeline_engine_d43f8e84dd.pipeline_runs(status) WHERE status = 'running';

CREATE TABLE plugin_pipeline_engine_d43f8e84dd.pipeline_stages (
  id UUID PRIMARY KEY,
  pipeline_run_id UUID NOT NULL REFERENCES plugin_pipeline_engine_d43f8e84dd.pipeline_runs(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  sub_issue_id UUID,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  output JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_pe_stages_run ON plugin_pipeline_engine_d43f8e84dd.pipeline_stages(pipeline_run_id);
CREATE INDEX idx_pe_stages_sub_issue ON plugin_pipeline_engine_d43f8e84dd.pipeline_stages(sub_issue_id) WHERE sub_issue_id IS NOT NULL;
CREATE UNIQUE INDEX idx_pe_stages_run_stage ON plugin_pipeline_engine_d43f8e84dd.pipeline_stages(pipeline_run_id, stage_id);

CREATE TABLE plugin_pipeline_engine_d43f8e84dd.sub_pipeline_runs (
  id UUID PRIMARY KEY,
  parent_pipeline_run_id UUID NOT NULL REFERENCES plugin_pipeline_engine_d43f8e84dd.pipeline_runs(id) ON DELETE CASCADE,
  parent_stage_id UUID NOT NULL REFERENCES plugin_pipeline_engine_d43f8e84dd.pipeline_stages(id) ON DELETE CASCADE,
  child_pipeline_run_id UUID NOT NULL REFERENCES plugin_pipeline_engine_d43f8e84dd.pipeline_runs(id) ON DELETE CASCADE,
  task_index INTEGER NOT NULL,
  ordering_position INTEGER NOT NULL
);

CREATE INDEX idx_pe_sub_pipeline_parent ON plugin_pipeline_engine_d43f8e84dd.sub_pipeline_runs(parent_pipeline_run_id);
CREATE INDEX idx_pe_sub_pipeline_child ON plugin_pipeline_engine_d43f8e84dd.sub_pipeline_runs(child_pipeline_run_id);
