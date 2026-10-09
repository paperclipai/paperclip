-- Reapplication is safe for instances that used the earlier development migration number.
CREATE TABLE IF NOT EXISTS "execution_workspace_repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"execution_workspace_id" uuid NOT NULL,
	"requested_by_issue_id" uuid,
	"repository_identity" text NOT NULL,
	"catalog_repository_id" text,
	"repo_url" text NOT NULL,
	"relative_path" text NOT NULL,
	"requested_ref" text DEFAULT 'HEAD' NOT NULL,
	"pinned_commit" text,
	"branch_name" text,
	"request_key" text NOT NULL,
	"request_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP CONSTRAINT IF EXISTS "execution_workspaces_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "execution_workspaces" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_endpoint_resources" ADD COLUMN IF NOT EXISTS "execution_defaults" jsonb;--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD COLUMN IF NOT EXISTS "execution_defaults" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "workspace_binding_revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "workspace_selection" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "workspace_pending_selection" jsonb;--> statement-breakpoint
DO $migration$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'execution_workspace_repositories'::regclass AND conname = 'execution_workspace_repositories_company_id_companies_id_fk') THEN
    ALTER TABLE "execution_workspace_repositories" ADD CONSTRAINT "execution_workspace_repositories_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $migration$;--> statement-breakpoint
DO $migration$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'execution_workspace_repositories'::regclass AND conname = 'execution_workspace_repositories_execution_workspace_id_execution_workspaces_id_fk') THEN
    ALTER TABLE "execution_workspace_repositories" ADD CONSTRAINT "execution_workspace_repositories_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $migration$;--> statement-breakpoint
DO $migration$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'execution_workspace_repositories'::regclass AND conname = 'execution_workspace_repositories_requested_by_issue_id_issues_id_fk') THEN
    ALTER TABLE "execution_workspace_repositories" ADD CONSTRAINT "execution_workspace_repositories_requested_by_issue_id_issues_id_fk" FOREIGN KEY ("requested_by_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $migration$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_workspace_repositories_identity_idx" ON "execution_workspace_repositories" USING btree ("execution_workspace_id","repository_identity");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_workspace_repositories_path_idx" ON "execution_workspace_repositories" USING btree ("execution_workspace_id","relative_path");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "execution_workspace_repositories_request_idx" ON "execution_workspace_repositories" USING btree ("execution_workspace_id","request_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "execution_workspace_repositories_company_workspace_idx" ON "execution_workspace_repositories" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;