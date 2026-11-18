CREATE TABLE "responsibilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"owner_user_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"standard" text,
	"status" text DEFAULT 'proposed' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"evidence" text,
	"health_override" text,
	"health_note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"proposed_by_agent_id" uuid,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "responsibilities_status_check" CHECK ("responsibilities"."status" in ('proposed', 'active', 'let_go', 'dismissed')),
	CONSTRAINT "responsibilities_source_check" CHECK ("responsibilities"."source" in ('manual', 'onboarding')),
	CONSTRAINT "responsibilities_health_override_check" CHECK ("responsibilities"."health_override" is null or "responsibilities"."health_override" in ('behind', 'on_track'))
);
--> statement-breakpoint
CREATE TABLE "responsibility_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"responsibility_id" uuid NOT NULL,
	"project_id" uuid,
	"issue_id" uuid,
	"routine_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "responsibility_links_single_target_check" CHECK (("responsibility_links"."project_id" is not null)::int + ("responsibility_links"."issue_id" is not null)::int + ("responsibility_links"."routine_id" is not null)::int = 1)
);
--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibilities" ADD CONSTRAINT "responsibilities_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_links" ADD CONSTRAINT "responsibility_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_links" ADD CONSTRAINT "responsibility_links_responsibility_id_responsibilities_id_fk" FOREIGN KEY ("responsibility_id") REFERENCES "public"."responsibilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_links" ADD CONSTRAINT "responsibility_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_links" ADD CONSTRAINT "responsibility_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "responsibility_links" ADD CONSTRAINT "responsibility_links_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "responsibilities_company_owner_status_idx" ON "responsibilities" USING btree ("company_id","owner_user_id","status");--> statement-breakpoint
CREATE INDEX "responsibility_links_responsibility_idx" ON "responsibility_links" USING btree ("responsibility_id");--> statement-breakpoint
CREATE UNIQUE INDEX "responsibility_links_project_uq" ON "responsibility_links" USING btree ("project_id") WHERE "responsibility_links"."project_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "responsibility_links_issue_uq" ON "responsibility_links" USING btree ("issue_id") WHERE "responsibility_links"."issue_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "responsibility_links_routine_uq" ON "responsibility_links" USING btree ("routine_id") WHERE "responsibility_links"."routine_id" is not null;