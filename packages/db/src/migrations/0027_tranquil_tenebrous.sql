ALTER TABLE "issues" ADD COLUMN "execution_workspace_settings" jsonb;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "execution_workspace_policy" jsonb;