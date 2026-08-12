ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "completion_requirement" text;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "completion_requirement_revision" integer NOT NULL DEFAULT 0;
ALTER TABLE "project_workspaces" ADD COLUMN IF NOT EXISTS "default_completion_requirement" text;
