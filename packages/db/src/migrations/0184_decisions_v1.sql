CREATE TABLE "decision_bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"origin_agent_id" uuid NOT NULL,
	"origin_issue_id" uuid NOT NULL,
	"origin_run_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"bundle_id" uuid,
	"origin_agent_id" uuid NOT NULL,
	"origin_issue_id" uuid NOT NULL,
	"origin_run_id" uuid NOT NULL,
	"rule_key" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"options" jsonb NOT NULL,
	"inputs" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"execution_status" text,
	"chosen_option_id" text,
	"input_values" jsonb,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"idempotency_key" text,
	"signed_spec" text NOT NULL,
	"target_snapshots" jsonb NOT NULL,
	"continuation_policy" text DEFAULT 'none' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_target_issues" (
	"decision_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	CONSTRAINT "decision_target_issues_decision_id_issue_id_pk" PRIMARY KEY("decision_id","issue_id")
);
--> statement-breakpoint
CREATE TABLE "decision_effect_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_id" uuid NOT NULL,
	"effect_index" integer NOT NULL,
	"effect_type" text NOT NULL,
	"target_issue_id" uuid NOT NULL,
	"status" text DEFAULT 'claimed' NOT NULL,
	"result" jsonb,
	"error" text,
	"activity_log_id" uuid,
	"executed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "decision_bundles" ADD CONSTRAINT "decision_bundles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_bundles" ADD CONSTRAINT "decision_bundles_origin_agent_id_agents_id_fk" FOREIGN KEY ("origin_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_bundles" ADD CONSTRAINT "decision_bundles_origin_issue_id_issues_id_fk" FOREIGN KEY ("origin_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_bundles" ADD CONSTRAINT "decision_bundles_origin_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_bundle_id_decision_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."decision_bundles"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_origin_agent_id_agents_id_fk" FOREIGN KEY ("origin_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_origin_issue_id_issues_id_fk" FOREIGN KEY ("origin_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_origin_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("origin_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_target_issues" ADD CONSTRAINT "decision_target_issues_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_target_issues" ADD CONSTRAINT "decision_target_issues_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_target_issues" ADD CONSTRAINT "decision_target_issues_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_effect_executions" ADD CONSTRAINT "decision_effect_executions_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_effect_executions" ADD CONSTRAINT "decision_effect_executions_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decision_effect_executions" ADD CONSTRAINT "decision_effect_executions_activity_log_id_activity_log_id_fk" FOREIGN KEY ("activity_log_id") REFERENCES "public"."activity_log"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "decision_bundles_company_created_at_idx" ON "decision_bundles" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "decisions_company_idempotency_uq" ON "decisions" USING btree ("company_id","idempotency_key") WHERE "decisions"."idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "decisions_company_status_expires_at_idx" ON "decisions" USING btree ("company_id","status","expires_at");
--> statement-breakpoint
CREATE INDEX "decisions_bundle_idx" ON "decisions" USING btree ("bundle_id");
--> statement-breakpoint
CREATE INDEX "decisions_origin_issue_idx" ON "decisions" USING btree ("origin_issue_id");
--> statement-breakpoint
CREATE INDEX "decision_target_issues_decision_idx" ON "decision_target_issues" USING btree ("decision_id");
--> statement-breakpoint
CREATE INDEX "decision_target_issues_issue_idx" ON "decision_target_issues" USING btree ("issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "decision_effect_executions_decision_effect_uq" ON "decision_effect_executions" USING btree ("decision_id","effect_index");
--> statement-breakpoint
CREATE INDEX "decision_effect_executions_target_issue_idx" ON "decision_effect_executions" USING btree ("target_issue_id");
