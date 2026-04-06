CREATE TABLE IF NOT EXISTS "review_pipeline_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "description" text,
  "stages" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_default" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "project_review_defaults" (
  "project_id" uuid PRIMARY KEY REFERENCES "projects"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "review_pipeline_template_id" uuid NOT NULL REFERENCES "review_pipeline_templates"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "deliverables" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "title" text NOT NULL,
  "description" text,
  "type" text NOT NULL DEFAULT 'mixed',
  "status" text NOT NULL DEFAULT 'draft',
  "priority" text NOT NULL DEFAULT 'medium',
  "current_stage_index" integer NOT NULL DEFAULT 0,
  "review_pipeline_template_id" uuid REFERENCES "review_pipeline_templates"("id") ON DELETE SET NULL,
  "submitted_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "submitted_by_user_id" text,
  "due_at" timestamp with time zone,
  "submitted_at" timestamp with time zone,
  "approved_at" timestamp with time zone,
  "rejected_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "deliverable_contents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deliverable_id" uuid NOT NULL REFERENCES "deliverables"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "url" text,
  "file_path" text,
  "original_filename" text,
  "mime_type" text,
  "size_bytes" bigint,
  "metadata" jsonb,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "deliverable_review_stages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deliverable_id" uuid NOT NULL REFERENCES "deliverables"("id") ON DELETE CASCADE,
  "stage_index" integer NOT NULL,
  "label" text NOT NULL,
  "reviewer_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "reviewer_user_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "decision_note" text,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "deliverable_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "deliverable_id" uuid NOT NULL REFERENCES "deliverables"("id") ON DELETE CASCADE,
  "stage_id" uuid REFERENCES "deliverable_review_stages"("id") ON DELETE SET NULL,
  "author_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "author_user_id" text,
  "body" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_review_pipeline_templates_company" ON "review_pipeline_templates" ("company_id");
CREATE INDEX IF NOT EXISTS "idx_project_review_defaults_company" ON "project_review_defaults" ("company_id");
CREATE INDEX IF NOT EXISTS "idx_deliverables_company_status" ON "deliverables" ("company_id", "status");
CREATE INDEX IF NOT EXISTS "idx_deliverables_company_project" ON "deliverables" ("company_id", "project_id");
CREATE INDEX IF NOT EXISTS "idx_deliverables_company_issue" ON "deliverables" ("company_id", "issue_id");
CREATE INDEX IF NOT EXISTS "idx_deliverables_submitted_by_agent" ON "deliverables" ("submitted_by_agent_id");
CREATE INDEX IF NOT EXISTS "idx_deliverable_contents_deliverable" ON "deliverable_contents" ("deliverable_id");
CREATE UNIQUE INDEX IF NOT EXISTS "idx_deliverable_review_stages_unique" ON "deliverable_review_stages" ("deliverable_id", "stage_index");
CREATE INDEX IF NOT EXISTS "idx_deliverable_review_stages_deliverable" ON "deliverable_review_stages" ("deliverable_id");
CREATE INDEX IF NOT EXISTS "idx_deliverable_comments_deliverable" ON "deliverable_comments" ("deliverable_id");
