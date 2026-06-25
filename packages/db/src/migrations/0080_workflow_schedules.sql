CREATE TABLE "workflow_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "cron_expression" text NOT NULL,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "template_markdown" text NOT NULL,
  "last_fired_at" timestamptz,
  "next_run_at" timestamptz,
  "created_by_user_id" text,
  "updated_by_user_id" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "workflow_schedules_company_status_idx" ON "workflow_schedules" ("company_id","status");
CREATE INDEX "workflow_schedules_workflow_next_run_idx" ON "workflow_schedules" ("workflow_id","next_run_at");
CREATE INDEX "workflow_schedules_company_next_run_idx" ON "workflow_schedules" ("company_id","next_run_at");
