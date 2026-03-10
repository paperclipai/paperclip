CREATE TABLE "briefing_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"record_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"cadence" text NOT NULL,
	"timezone" text NOT NULL,
	"local_hour" integer NOT NULL,
	"local_minute" integer NOT NULL,
	"day_of_week" integer,
	"window_preset" text NOT NULL,
	"auto_publish" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_run_status" text DEFAULT 'idle' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"body_md" text,
	"source_record_id" uuid,
	"kind" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_ref_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'planned' NOT NULL,
	"target_date" text,
	"completed_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_checkouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_workspace_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"last_run_id" uuid,
	"branch_name" text,
	"worktree_path" text,
	"status" text DEFAULT 'active' NOT NULL,
	"base_ref" text,
	"released_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "briefing_schedules" ADD CONSTRAINT "briefing_schedules_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefing_schedules" ADD CONSTRAINT "briefing_schedules_record_id_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_entries" ADD CONSTRAINT "knowledge_entries_source_record_id_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_milestones" ADD CONSTRAINT "project_milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_checkouts" ADD CONSTRAINT "workspace_checkouts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_checkouts" ADD CONSTRAINT "workspace_checkouts_project_workspace_id_project_workspaces_id_fk" FOREIGN KEY ("project_workspace_id") REFERENCES "public"."project_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_checkouts" ADD CONSTRAINT "workspace_checkouts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_checkouts" ADD CONSTRAINT "workspace_checkouts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_checkouts" ADD CONSTRAINT "workspace_checkouts_last_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "briefing_schedules_record_uq" ON "briefing_schedules" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "briefing_schedules_company_next_run_idx" ON "briefing_schedules" USING btree ("company_id","enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "knowledge_entries_company_scope_idx" ON "knowledge_entries" USING btree ("company_id","scope_type","scope_ref_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_entries_source_record_uq" ON "knowledge_entries" USING btree ("source_record_id");--> statement-breakpoint
CREATE INDEX "project_milestones_company_project_idx" ON "project_milestones" USING btree ("company_id","project_id","sort_order");--> statement-breakpoint
CREATE INDEX "workspace_checkouts_issue_agent_idx" ON "workspace_checkouts" USING btree ("company_id","issue_id","agent_id","updated_at");--> statement-breakpoint
CREATE INDEX "workspace_checkouts_workspace_status_idx" ON "workspace_checkouts" USING btree ("project_workspace_id","status","updated_at");