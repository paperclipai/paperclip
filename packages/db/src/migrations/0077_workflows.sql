CREATE TABLE "workflows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "description" text,
  "status" text DEFAULT 'active' NOT NULL,
  "runner_type" text DEFAULT 'google_adk' NOT NULL,
  "runner_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "pipeline_definition" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "pipeline_source_hash" text,
  "created_by_user_id" text,
  "updated_by_user_id" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "workflow_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE cascade,
  "status" text DEFAULT 'queued' NOT NULL,
  "input_markdown" text NOT NULL,
  "error" text,
  "summary" text,
  "provider" text,
  "model" text,
  "usage" jsonb,
  "context_snapshot" jsonb,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "workflow_run_phases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "workflow_run_id" uuid NOT NULL REFERENCES "workflow_runs"("id") ON DELETE cascade,
  "phase_key" text NOT NULL,
  "label" text NOT NULL,
  "kind" text DEFAULT 'phase' NOT NULL,
  "ordinal" integer DEFAULT 0 NOT NULL,
  "status" text DEFAULT 'idle' NOT NULL,
  "metadata" jsonb,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "workflow_handoffs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "workflow_run_id" uuid NOT NULL REFERENCES "workflow_runs"("id") ON DELETE cascade,
  "phase_key" text NOT NULL,
  "kind" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "prompt_markdown" text NOT NULL,
  "response_markdown" text,
  "decided_by_user_id" text,
  "decided_at" timestamptz,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE "workflow_deliverables" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE cascade,
  "workflow_run_id" uuid NOT NULL REFERENCES "workflow_runs"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "summary" text,
  "audience" text DEFAULT 'human' NOT NULL,
  "content_type" text NOT NULL,
  "content_path" text,
  "content_body" text,
  "byte_size" integer DEFAULT 0 NOT NULL,
  "original_filename" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "workflows_company_status_idx" ON "workflows" ("company_id","status");
CREATE INDEX "workflows_company_updated_idx" ON "workflows" ("company_id","updated_at");
CREATE INDEX "workflow_runs_company_workflow_created_idx" ON "workflow_runs" ("company_id","workflow_id","created_at");
CREATE INDEX "workflow_runs_workflow_status_idx" ON "workflow_runs" ("workflow_id","status");
CREATE INDEX "workflow_run_phases_run_ordinal_idx" ON "workflow_run_phases" ("workflow_run_id","ordinal");
CREATE INDEX "workflow_run_phases_run_phase_key_idx" ON "workflow_run_phases" ("workflow_run_id","phase_key");
CREATE UNIQUE INDEX "workflow_run_phases_run_id_phase_key_unique" ON "workflow_run_phases" ("workflow_run_id","phase_key");
CREATE INDEX "workflow_handoffs_run_status_idx" ON "workflow_handoffs" ("workflow_run_id","status");
CREATE INDEX "workflow_handoffs_run_phase_idx" ON "workflow_handoffs" ("workflow_run_id","phase_key");
CREATE INDEX "workflow_deliverables_company_created_idx" ON "workflow_deliverables" ("company_id","created_at");
CREATE INDEX "workflow_deliverables_workflow_created_idx" ON "workflow_deliverables" ("workflow_id","created_at" DESC);
CREATE INDEX "workflow_deliverables_run_created_idx" ON "workflow_deliverables" ("workflow_run_id","created_at");
