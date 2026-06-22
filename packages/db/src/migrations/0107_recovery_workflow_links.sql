CREATE TABLE "recovery_workflow_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"instance_id" text NOT NULL,
	"mode" text DEFAULT 'shadow' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recovery_workflow_links" ADD CONSTRAINT "recovery_workflow_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_workflow_links" ADD CONSTRAINT "recovery_workflow_links_action_id_issue_recovery_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."issue_recovery_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_workflow_links_action_uniq" ON "recovery_workflow_links" USING btree ("action_id");