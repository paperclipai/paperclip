CREATE TABLE "execution_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"decision_kind" text NOT NULL,
	"decision_id" uuid NOT NULL,
	"proposer_agent_id" uuid NOT NULL,
	"approver_agent_id" uuid,
	"approver_user_id" text,
	"executor_agent_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"target_revision_id" uuid,
	"request_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"policy_version" integer NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "execution_grants" ADD CONSTRAINT "execution_grants_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_grants" ADD CONSTRAINT "execution_grants_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_grants_company_decision_uq" ON "execution_grants" USING btree ("company_id","decision_kind","decision_id");--> statement-breakpoint
CREATE INDEX "execution_grants_company_target_idx" ON "execution_grants" USING btree ("company_id","target_agent_id");