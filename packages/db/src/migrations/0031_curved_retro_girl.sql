CREATE TABLE "issue_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"blocked_issue_id" uuid NOT NULL,
	"blocking_issue_id" uuid NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_blocked_issue_id_issues_id_fk" FOREIGN KEY ("blocked_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_blocking_issue_id_issues_id_fk" FOREIGN KEY ("blocking_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_dependencies" ADD CONSTRAINT "issue_dependencies_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_deps_blocked" ON "issue_dependencies" USING btree ("blocked_issue_id");--> statement-breakpoint
CREATE INDEX "idx_deps_blocking" ON "issue_dependencies" USING btree ("blocking_issue_id");--> statement-breakpoint
CREATE INDEX "idx_deps_company" ON "issue_dependencies" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_deps_unique" ON "issue_dependencies" USING btree ("blocked_issue_id","blocking_issue_id");
