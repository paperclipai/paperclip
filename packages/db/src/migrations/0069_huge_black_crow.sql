CREATE TABLE "issue_workflow_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"root_issue_id" uuid NOT NULL,
	"template_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_workflow_lane_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_lane_id" uuid NOT NULL,
	"artifact_key" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"blocking" boolean DEFAULT true NOT NULL,
	"document_key" text,
	"work_product_types" jsonb,
	"comment_markers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issue_workflow_lanes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"workflow_instance_id" uuid NOT NULL,
	"root_issue_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"lane_role" text NOT NULL,
	"reviewer_agent_id" uuid,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_workflow_instances" ADD CONSTRAINT "issue_workflow_instances_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_instances" ADD CONSTRAINT "issue_workflow_instances_root_issue_id_issues_id_fk" FOREIGN KEY ("root_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_lane_artifacts" ADD CONSTRAINT "issue_workflow_lane_artifacts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_lane_artifacts" ADD CONSTRAINT "issue_workflow_lane_artifacts_workflow_lane_id_issue_workflow_lanes_id_fk" FOREIGN KEY ("workflow_lane_id") REFERENCES "public"."issue_workflow_lanes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_lanes" ADD CONSTRAINT "issue_workflow_lanes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_lanes" ADD CONSTRAINT "issue_workflow_lanes_workflow_instance_id_issue_workflow_instances_id_fk" FOREIGN KEY ("workflow_instance_id") REFERENCES "public"."issue_workflow_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_lanes" ADD CONSTRAINT "issue_workflow_lanes_root_issue_id_issues_id_fk" FOREIGN KEY ("root_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_lanes" ADD CONSTRAINT "issue_workflow_lanes_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_workflow_lanes" ADD CONSTRAINT "issue_workflow_lanes_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_workflow_instances_root_issue_idx" ON "issue_workflow_instances" USING btree ("root_issue_id");--> statement-breakpoint
CREATE INDEX "issue_workflow_instances_company_template_idx" ON "issue_workflow_instances" USING btree ("company_id","template_key");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_workflow_lane_artifacts_lane_key_idx" ON "issue_workflow_lane_artifacts" USING btree ("workflow_lane_id","artifact_key");--> statement-breakpoint
CREATE INDEX "issue_workflow_lane_artifacts_company_kind_idx" ON "issue_workflow_lane_artifacts" USING btree ("company_id","kind");--> statement-breakpoint
CREATE INDEX "issue_workflow_lane_artifacts_blocking_idx" ON "issue_workflow_lane_artifacts" USING btree ("workflow_lane_id","blocking") WHERE "issue_workflow_lane_artifacts"."blocking" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "issue_workflow_lanes_issue_idx" ON "issue_workflow_lanes" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_workflow_lanes_instance_lane_idx" ON "issue_workflow_lanes" USING btree ("workflow_instance_id","lane_role");--> statement-breakpoint
CREATE INDEX "issue_workflow_lanes_root_lane_idx" ON "issue_workflow_lanes" USING btree ("root_issue_id","lane_role");