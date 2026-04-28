CREATE TABLE "rt2_v33_execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_issue_id" uuid NOT NULL,
	"todo_issue_id" uuid,
	"deliverable_work_product_id" uuid,
	"result_work_product_id" uuid,
	"retry_of_attempt_id" uuid,
	"state" text DEFAULT 'queued' NOT NULL,
	"executor_type" text,
	"executor_id" text,
	"execution_workspace_id" uuid,
	"runtime_service_id" uuid,
	"heartbeat_run_id" uuid,
	"failure_reason" text,
	"missing_deliverable_reason" text,
	"metadata" jsonb,
	"queued_by_user_id" text NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rt2_v33_execution_attempts_state_check" CHECK ("rt2_v33_execution_attempts"."state" in ('queued', 'claimed', 'running', 'completed', 'failed', 'cancelled', 'blocked')),
	CONSTRAINT "rt2_v33_execution_attempts_executor_type_check" CHECK ("rt2_v33_execution_attempts"."executor_type" is null or "rt2_v33_execution_attempts"."executor_type" in ('user', 'jarvis', 'runtime'))
);
--> statement-breakpoint
ALTER TABLE "rt2_v33_execution_attempts" ADD CONSTRAINT "rt2_v33_execution_attempts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_execution_attempts" ADD CONSTRAINT "rt2_v33_execution_attempts_task_issue_id_issues_id_fk" FOREIGN KEY ("task_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_execution_attempts" ADD CONSTRAINT "rt2_v33_execution_attempts_todo_issue_id_issues_id_fk" FOREIGN KEY ("todo_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_execution_attempts" ADD CONSTRAINT "rt2_v33_execution_attempts_deliverable_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("deliverable_work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_execution_attempts" ADD CONSTRAINT "rt2_v33_execution_attempts_result_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("result_work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_execution_attempts" ADD CONSTRAINT "rt2_v33_execution_attempts_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_execution_attempts" ADD CONSTRAINT "rt2_v33_execution_attempts_runtime_service_id_workspace_runtime_services_id_fk" FOREIGN KEY ("runtime_service_id") REFERENCES "public"."workspace_runtime_services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_execution_attempts" ADD CONSTRAINT "rt2_v33_execution_attempts_heartbeat_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rt2_v33_execution_attempts" ADD CONSTRAINT "rt2_v33_execution_attempts_retry_of_attempt_id_rt2_v33_execution_attempts_id_fk" FOREIGN KEY ("retry_of_attempt_id") REFERENCES "public"."rt2_v33_execution_attempts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rt2_v33_execution_attempts_task_updated_idx" ON "rt2_v33_execution_attempts" USING btree ("task_issue_id","updated_at");--> statement-breakpoint
CREATE INDEX "rt2_v33_execution_attempts_todo_updated_idx" ON "rt2_v33_execution_attempts" USING btree ("todo_issue_id","updated_at");--> statement-breakpoint
CREATE INDEX "rt2_v33_execution_attempts_company_state_idx" ON "rt2_v33_execution_attempts" USING btree ("company_id","state","updated_at");
