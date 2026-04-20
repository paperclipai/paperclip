CREATE TABLE "background_job_cost_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"cost_event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text,
	"progress_percent" integer,
	"total_items" integer,
	"processed_items" integer,
	"succeeded_items" integer,
	"failed_items" integer,
	"skipped_items" integer,
	"current_item" text,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"job_id" uuid,
	"job_key" text NOT NULL,
	"job_type" text NOT NULL,
	"trigger" text DEFAULT 'manual' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"requested_by_actor_type" text DEFAULT 'system' NOT NULL,
	"requested_by_actor_id" text DEFAULT 'system' NOT NULL,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"source_issue_id" uuid,
	"source_project_id" uuid,
	"source_agent_id" uuid,
	"heartbeat_run_id" uuid,
	"total_items" integer,
	"processed_items" integer DEFAULT 0 NOT NULL,
	"succeeded_items" integer DEFAULT 0 NOT NULL,
	"failed_items" integer DEFAULT 0 NOT NULL,
	"skipped_items" integer DEFAULT 0 NOT NULL,
	"progress_percent" integer,
	"current_item" text,
	"cancellation_requested_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"error" text,
	"result" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"job_type" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text,
	"backend_kind" text DEFAULT 'server_worker' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"source_issue_id" uuid,
	"source_project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "background_job_cost_events" ADD CONSTRAINT "background_job_cost_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job_cost_events" ADD CONSTRAINT "background_job_cost_events_run_id_background_job_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."background_job_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job_cost_events" ADD CONSTRAINT "background_job_cost_events_cost_event_id_cost_events_id_fk" FOREIGN KEY ("cost_event_id") REFERENCES "public"."cost_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job_events" ADD CONSTRAINT "background_job_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job_events" ADD CONSTRAINT "background_job_events_run_id_background_job_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."background_job_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD CONSTRAINT "background_job_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD CONSTRAINT "background_job_runs_job_id_background_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."background_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD CONSTRAINT "background_job_runs_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD CONSTRAINT "background_job_runs_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD CONSTRAINT "background_job_runs_source_project_id_projects_id_fk" FOREIGN KEY ("source_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD CONSTRAINT "background_job_runs_source_agent_id_agents_id_fk" FOREIGN KEY ("source_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_job_runs" ADD CONSTRAINT "background_job_runs_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "background_jobs" ADD CONSTRAINT "background_jobs_source_project_id_projects_id_fk" FOREIGN KEY ("source_project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "background_job_cost_events_run_idx" ON "background_job_cost_events" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "background_job_cost_events_cost_event_uq" ON "background_job_cost_events" USING btree ("cost_event_id");--> statement-breakpoint
CREATE INDEX "background_job_events_run_created_idx" ON "background_job_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "background_job_events_company_created_idx" ON "background_job_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "background_job_runs_company_created_idx" ON "background_job_runs" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "background_job_runs_company_type_status_idx" ON "background_job_runs" USING btree ("company_id","job_type","status");--> statement-breakpoint
CREATE INDEX "background_job_runs_company_issue_created_idx" ON "background_job_runs" USING btree ("company_id","source_issue_id","created_at");--> statement-breakpoint
CREATE INDEX "background_job_runs_job_created_idx" ON "background_job_runs" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE INDEX "background_jobs_company_type_status_idx" ON "background_jobs" USING btree ("company_id","job_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_company_key_uq" ON "background_jobs" USING btree ("company_id","key");