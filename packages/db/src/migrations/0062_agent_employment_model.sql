-- Agent Employment Model: new columns on agents, plus agent_memory_entries,
-- hiring_requests, and agent_role_templates tables.

-- agents table - add employment model columns
ALTER TABLE "agents" ADD COLUMN "employment_type" text NOT NULL DEFAULT 'full_time';
ALTER TABLE "agents" ADD COLUMN "hired_at" timestamp with time zone DEFAULT now();
ALTER TABLE "agents" ADD COLUMN "hired_by_user_id" text;
ALTER TABLE "agents" ADD COLUMN "hired_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL;
ALTER TABLE "agents" ADD COLUMN "contract_end_at" timestamp with time zone;
ALTER TABLE "agents" ADD COLUMN "contract_end_condition" text;
ALTER TABLE "agents" ADD COLUMN "contract_project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL;
ALTER TABLE "agents" ADD COLUMN "contract_budget_cents" integer;
ALTER TABLE "agents" ADD COLUMN "contract_spent_cents" integer NOT NULL DEFAULT 0;
ALTER TABLE "agents" ADD COLUMN "terminated_at" timestamp with time zone;
ALTER TABLE "agents" ADD COLUMN "termination_reason" text;
ALTER TABLE "agents" ADD COLUMN "department" text;
ALTER TABLE "agents" ADD COLUMN "onboarding_context_ids" jsonb NOT NULL DEFAULT '[]';
ALTER TABLE "agents" ADD COLUMN "performance_score" integer;

CREATE INDEX IF NOT EXISTS "agents_company_employment_type_idx" ON "agents" ("company_id", "employment_type");
CREATE INDEX IF NOT EXISTS "agents_company_department_idx" ON "agents" ("company_id", "department");
CREATE INDEX IF NOT EXISTS "agents_contract_end_at_idx" ON "agents" ("contract_end_at") WHERE "employment_type" = 'contractor' AND "terminated_at" IS NULL;

-- agent_memory_entries table
CREATE TABLE IF NOT EXISTS "agent_memory_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "memory_type" text NOT NULL DEFAULT 'semantic',
  "category" text,
  "content" text NOT NULL,
  "source_issue_id" uuid,
  "source_project_id" uuid,
  "confidence" integer NOT NULL DEFAULT 80,
  "access_count" integer NOT NULL DEFAULT 0,
  "last_accessed_at" timestamp with time zone,
  "expires_at" timestamp with time zone,
  "archived_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "agent_memory_entries_agent_type_idx" ON "agent_memory_entries" ("agent_id", "memory_type");
CREATE INDEX IF NOT EXISTS "agent_memory_entries_company_agent_idx" ON "agent_memory_entries" ("company_id", "agent_id");
CREATE INDEX IF NOT EXISTS "agent_memory_entries_expires_at_idx" ON "agent_memory_entries" ("expires_at") WHERE "expires_at" IS NOT NULL;

-- hiring_requests table
CREATE TABLE IF NOT EXISTS "hiring_requests" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "approval_id" uuid,
  "requested_by_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "requested_by_user_id" text,
  "employment_type" text NOT NULL DEFAULT 'full_time',
  "role" text NOT NULL,
  "title" text NOT NULL,
  "department" text,
  "justification" text,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "contract_duration_days" integer,
  "contract_budget_cents" integer,
  "onboarding_kb_page_ids" jsonb NOT NULL DEFAULT '[]',
  "reports_to_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "status" text NOT NULL DEFAULT 'draft',
  "fulfilled_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "hiring_requests_company_status_idx" ON "hiring_requests" ("company_id", "status");

-- agent_role_templates table
CREATE TABLE IF NOT EXISTS "agent_role_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "role" text NOT NULL,
  "department" text,
  "employment_type" text NOT NULL DEFAULT 'any',
  "title" text NOT NULL,
  "capabilities" text,
  "default_kb_page_ids" jsonb NOT NULL DEFAULT '[]',
  "default_permissions" jsonb NOT NULL DEFAULT '{}',
  "system_prompt_template" text,
  "is_system" boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "agent_role_templates_company_idx" ON "agent_role_templates" ("company_id");
