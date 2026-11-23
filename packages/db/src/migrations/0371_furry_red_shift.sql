CREATE TABLE "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD COLUMN "workflow_transition" jsonb;--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD COLUMN "workflow_prompt" text;--> statement-breakpoint
ALTER TABLE "case_handoffs" ADD COLUMN "base_workflow_document_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "cases" ADD COLUMN "workflow_id" uuid;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflows_company_idx" ON "workflows" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE restrict ON UPDATE no action;