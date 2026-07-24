CREATE TABLE "execution_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_id" uuid,
	"skill_id" uuid,
	"plugin_id" uuid,
	"skill_name" text,
	"skill_version_hash" text,
	"risk_tier" integer,
	"risk_tier_source" text NOT NULL,
	"inputs_redacted" jsonb NOT NULL,
	"tools_invoked" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gate_decisions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"eval_scores" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"content_hash" text NOT NULL,
	"prev_receipt_hash" text,
	"chain_seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_receipts_risk_tier_check" CHECK ("execution_receipts"."risk_tier" is null or "execution_receipts"."risk_tier" in (0, 1, 2)),
	CONSTRAINT "execution_receipts_risk_tier_source_check" CHECK ("execution_receipts"."risk_tier_source" in ('classifier', 'fail_safe_default')),
	CONSTRAINT "execution_receipts_outcome_check" CHECK ("execution_receipts"."outcome" in ('succeeded', 'failed', 'error'))
);
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "receipts_tier01_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_receipts" ADD CONSTRAINT "execution_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_receipts" ADD CONSTRAINT "execution_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_receipts" ADD CONSTRAINT "execution_receipts_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_receipts" ADD CONSTRAINT "execution_receipts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_receipts" ADD CONSTRAINT "execution_receipts_skill_id_company_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."company_skills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_receipts" ADD CONSTRAINT "execution_receipts_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "execution_receipts_company_created_idx" ON "execution_receipts" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "execution_receipts_company_chain_idx" ON "execution_receipts" USING btree ("company_id","chain_seq");--> statement-breakpoint
CREATE INDEX "execution_receipts_run_idx" ON "execution_receipts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "execution_receipts_skill_version_idx" ON "execution_receipts" USING btree ("company_id","skill_version_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_receipts_company_chain_seq_uq" ON "execution_receipts" USING btree ("company_id","chain_seq");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_receipts_run_uq" ON "execution_receipts" USING btree ("run_id");
