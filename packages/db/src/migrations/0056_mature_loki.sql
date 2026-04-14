CREATE TABLE "reviewed_artifact_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"set_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"source_type" text NOT NULL,
	"source_issue_id" uuid,
	"source_document_key" text,
	"source_document_revision_id" uuid,
	"source_issue_attachment_id" uuid,
	"source_issue_work_product_id" uuid,
	"source_external_url" text,
	"source_approval_payload_pointer" text,
	"source_execution_workspace_id" uuid,
	"source_run_id" uuid,
	"source_workspace_path" text,
	"title" text,
	"description" text,
	"display_hint" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"selected_explicitly" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewed_artifact_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"context_type" text NOT NULL,
	"context_issue_id" uuid,
	"approval_id" uuid,
	"selection_mode" text DEFAULT 'explicit' NOT NULL,
	"title" text,
	"description" text,
	"superseded_by_set_id" uuid,
	"superseded_at" timestamp with time zone,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reviewed_artifact_items" ADD CONSTRAINT "reviewed_artifact_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_items" ADD CONSTRAINT "reviewed_artifact_items_set_id_reviewed_artifact_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."reviewed_artifact_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_items" ADD CONSTRAINT "reviewed_artifact_items_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_items" ADD CONSTRAINT "reviewed_artifact_items_source_document_revision_id_document_revisions_id_fk" FOREIGN KEY ("source_document_revision_id") REFERENCES "public"."document_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_items" ADD CONSTRAINT "reviewed_artifact_items_source_issue_attachment_id_issue_attachments_id_fk" FOREIGN KEY ("source_issue_attachment_id") REFERENCES "public"."issue_attachments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_items" ADD CONSTRAINT "reviewed_artifact_items_source_issue_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("source_issue_work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_items" ADD CONSTRAINT "reviewed_artifact_items_source_execution_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("source_execution_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_items" ADD CONSTRAINT "reviewed_artifact_items_source_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_sets" ADD CONSTRAINT "reviewed_artifact_sets_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_sets" ADD CONSTRAINT "reviewed_artifact_sets_context_issue_id_issues_id_fk" FOREIGN KEY ("context_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_sets" ADD CONSTRAINT "reviewed_artifact_sets_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_sets" ADD CONSTRAINT "reviewed_artifact_sets_superseded_by_set_id_reviewed_artifact_sets_id_fk" FOREIGN KEY ("superseded_by_set_id") REFERENCES "public"."reviewed_artifact_sets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_sets" ADD CONSTRAINT "reviewed_artifact_sets_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewed_artifact_sets" ADD CONSTRAINT "reviewed_artifact_sets_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reviewed_artifact_items_set_order_uq" ON "reviewed_artifact_items" USING btree ("set_id","order_index");--> statement-breakpoint
CREATE INDEX "reviewed_artifact_items_company_set_idx" ON "reviewed_artifact_items" USING btree ("company_id","set_id");--> statement-breakpoint
CREATE INDEX "reviewed_artifact_items_company_source_issue_idx" ON "reviewed_artifact_items" USING btree ("company_id","source_issue_id");--> statement-breakpoint
CREATE INDEX "reviewed_artifact_items_company_source_type_idx" ON "reviewed_artifact_items" USING btree ("company_id","source_type");--> statement-breakpoint
CREATE INDEX "reviewed_artifact_sets_company_context_idx" ON "reviewed_artifact_sets" USING btree ("company_id","context_type","context_issue_id","approval_id");--> statement-breakpoint
CREATE INDEX "reviewed_artifact_sets_company_updated_idx" ON "reviewed_artifact_sets" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "reviewed_artifact_sets_superseded_by_idx" ON "reviewed_artifact_sets" USING btree ("superseded_by_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reviewed_artifact_sets_active_issue_review_uq" ON "reviewed_artifact_sets" USING btree ("company_id","context_issue_id") WHERE "reviewed_artifact_sets"."context_type" = 'issue_review' and "reviewed_artifact_sets"."selection_mode" = 'explicit' and "reviewed_artifact_sets"."superseded_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "reviewed_artifact_sets_active_approval_uq" ON "reviewed_artifact_sets" USING btree ("company_id","approval_id") WHERE "reviewed_artifact_sets"."context_type" = 'approval' and "reviewed_artifact_sets"."selection_mode" = 'explicit' and "reviewed_artifact_sets"."superseded_at" is null;