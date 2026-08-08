CREATE TABLE "issue_continuation_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"predecessor_issue_id" uuid NOT NULL,
	"successor_issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"residual_scope" text,
	"deliverable_key" text NOT NULL,
	"dependency_fingerprint" text NOT NULL,
	"continuation_fingerprint" text NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issue_recovery_actions" ADD COLUMN "continuation_fingerprint" text;--> statement-breakpoint
ALTER TABLE "issue_continuation_links" ADD CONSTRAINT "issue_continuation_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_continuation_links" ADD CONSTRAINT "issue_continuation_links_predecessor_issue_id_issues_id_fk" FOREIGN KEY ("predecessor_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_continuation_links" ADD CONSTRAINT "issue_continuation_links_successor_issue_id_issues_id_fk" FOREIGN KEY ("successor_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_continuation_links" ADD CONSTRAINT "issue_continuation_links_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issue_continuation_links" ADD CONSTRAINT "issue_continuation_links_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issue_continuation_links_company_predecessor_idx" ON "issue_continuation_links" USING btree ("company_id","predecessor_issue_id");--> statement-breakpoint
CREATE INDEX "issue_continuation_links_company_successor_idx" ON "issue_continuation_links" USING btree ("company_id","successor_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_continuation_links_predecessor_fingerprint_uq" ON "issue_continuation_links" USING btree ("company_id","predecessor_issue_id","continuation_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "issue_recovery_actions_active_continuation_fingerprint_uq" ON "issue_recovery_actions" USING btree ("company_id","continuation_fingerprint","cause") WHERE "issue_recovery_actions"."status" in ('active', 'escalated') and "issue_recovery_actions"."continuation_fingerprint" is not null;