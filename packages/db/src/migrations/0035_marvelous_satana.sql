CREATE TABLE "execution_workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"project_workspace_id" uuid,
	"source_issue_id" uuid,
	"mode" text NOT NULL,
	"strategy_type" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"cwd" text,
	"repo_url" text,
	"base_ref" text,
	"branch_name" text,
	"provider_type" text DEFAULT 'local_fs' NOT NULL,
	"provider_ref" text,
	"derived_from_execution_workspace_id" uuid,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"cleanup_eligible_at" timestamp with time zone,
	"cleanup_reason" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_work_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"issue_id" uuid NOT NULL,
	"execution_workspace_id" uuid,
	"runtime_service_id" uuid,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"external_id" text,
	"title" text NOT NULL,
	"url" text,
	"status" text NOT NULL,
	"review_state" text DEFAULT 'none' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"summary" text,
	"metadata" jsonb,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "project_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "execution_workspace_preference" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "source_type" text DEFAULT 'local_path' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "default_ref" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "visibility" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "setup_command" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "cleanup_command" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "remote_provider" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "remote_workspace_ref" text;--> statement-breakpoint
ALTER TABLE "project_workspaces" ADD COLUMN "shared_workspace_key" text;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD COLUMN "execution_workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_derived_from_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("derived_from_execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_runtime_service_id_workspace_runtime_services_id_fk" FOREIGN KEY ("runtime_service_id") REFERENCES "public"."workspace_runtime_services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD CONSTRAINT "issue_work_products_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_project_status_idx" ON "execution_workspaces" USING btree ("company_id","project_id","status");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_project_workspace_status_idx" ON "execution_workspaces" USING btree ("company_id","project_workspace_id","status");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_source_issue_idx" ON "execution_workspaces" USING btree ("company_id","source_issue_id");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_last_used_idx" ON "execution_workspaces" USING btree ("company_id","last_used_at");--> statement-breakpoint
CREATE INDEX "execution_workspaces_company_branch_idx" ON "execution_workspaces" USING btree ("company_id","branch_name");--> statement-breakpoint
CREATE INDEX "issue_work_products_company_issue_type_idx" ON "issue_work_products" USING btree ("company_id","issue_id","type");--> statement-breakpoint
CREATE INDEX "issue_work_products_company_execution_workspace_type_idx" ON "issue_work_products" USING btree ("company_id","execution_workspace_id","type");--> statement-breakpoint
CREATE INDEX "issue_work_products_company_provider_external_id_idx" ON "issue_work_products" USING btree ("company_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "issue_work_products_company_updated_idx" ON "issue_work_products" USING btree ("company_id","updated_at");--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_runtime_services" ADD CONSTRAINT "workspace_runtime_services_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_company_project_workspace_idx" ON "issues" USING btree ("company_id","project_workspace_id");--> statement-breakpoint
CREATE INDEX "issues_company_execution_workspace_idx" ON "issues" USING btree ("company_id","execution_workspace_id");--> statement-breakpoint
CREATE INDEX "project_workspaces_project_source_type_idx" ON "project_workspaces" USING btree ("project_id","source_type");--> statement-breakpoint
CREATE INDEX "project_workspaces_company_shared_key_idx" ON "project_workspaces" USING btree ("company_id","shared_workspace_key");--> statement-breakpoint
CREATE UNIQUE INDEX "project_workspaces_project_remote_ref_idx" ON "project_workspaces" USING btree ("project_id","remote_provider","remote_workspace_ref");--> statement-breakpoint
CREATE INDEX "workspace_runtime_services_company_execution_workspace_status_idx" ON "workspace_runtime_services" USING btree ("company_id","execution_workspace_id","status");