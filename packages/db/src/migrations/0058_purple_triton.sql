CREATE TABLE "workflow_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"nodes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "workflow_template_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "workflow_invoke_input" jsonb;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD CONSTRAINT "workflow_templates_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_templates_company_idx" ON "workflow_templates" USING btree ("company_id");--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_workflow_template_id_workflow_templates_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_templates"("id") ON DELETE set null ON UPDATE no action;