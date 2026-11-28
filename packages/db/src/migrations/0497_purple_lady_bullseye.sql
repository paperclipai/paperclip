CREATE TABLE "responsibility_dashboard_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"cause" text NOT NULL,
	"summary" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"snapshot_hash" text NOT NULL,
	"actor_user_id" text,
	"actor_agent_id" uuid,
	"issue_id" uuid,
	"interaction_id" uuid,
	"previous_version_id" uuid,
	"restored_from_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "responsibility_dashboard_versions_cause_check" CHECK ("responsibility_dashboard_versions"."cause" in ('change_set', 'person', 'restore'))
);
--> statement-breakpoint
ALTER TABLE "responsibility_dashboard_versions" ADD CONSTRAINT "responsibility_dashboard_versions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_dashboard_versions" ADD CONSTRAINT "responsibility_dashboard_versions_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_dashboard_versions" ADD CONSTRAINT "responsibility_dashboard_versions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_dashboard_versions" ADD CONSTRAINT "responsibility_dashboard_versions_previous_version_id_responsibility_dashboard_versions_id_fk" FOREIGN KEY ("previous_version_id") REFERENCES "public"."responsibility_dashboard_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_dashboard_versions" ADD CONSTRAINT "responsibility_dashboard_versions_restored_from_version_id_responsibility_dashboard_versions_id_fk" FOREIGN KEY ("restored_from_version_id") REFERENCES "public"."responsibility_dashboard_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "responsibility_dashboard_versions_owner_created_idx" ON "responsibility_dashboard_versions" USING btree ("company_id","owner_user_id","created_at","id");