CREATE TABLE "agent_contract_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"contract_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"lane_key" text,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"allowed_issue_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_evidence_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_evidence_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_approval_for" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_run_duration_seconds" integer,
	"contract" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"change_summary" text,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"activated_by_user_id" text,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"lane_policy_id" uuid,
	"lane_key" text,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"allowed_issue_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_evidence_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_evidence_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requires_approval_for" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_run_duration_seconds" integer,
	"contract" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autonomy_evidence_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"verdict" text DEFAULT 'pending' NOT NULL,
	"lane_key" text,
	"run_id" uuid,
	"issue_id" uuid,
	"agent_id" uuid,
	"approval_id" uuid,
	"source_type" text NOT NULL,
	"source_id" text,
	"source_ref" jsonb,
	"title" text NOT NULL,
	"summary" text,
	"uri" text,
	"payload" jsonb,
	"validator_name" text,
	"validator_version" text,
	"validator_message" text,
	"validator_payload" jsonb,
	"validated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autonomy_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"type" text NOT NULL,
	"severity" text DEFAULT 'error' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"lane_key" text,
	"run_id" uuid,
	"issue_id" uuid,
	"agent_id" uuid,
	"approval_id" uuid,
	"source_type" text NOT NULL,
	"source_id" text,
	"source_ref" jsonb,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"remediation" text,
	"stops_lane" boolean DEFAULT false NOT NULL,
	"idempotency_key" text,
	"metadata" jsonb,
	"acknowledged_by_user_id" text,
	"acknowledged_at" timestamp with time zone,
	"resolved_by_user_id" text,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autonomy_run_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"issue_id" uuid,
	"agent_id" uuid,
	"lane_key" text,
	"from_state" text,
	"to_state" text NOT NULL,
	"terminal_classification" text,
	"reason" text,
	"actor_type" text DEFAULT 'kernel' NOT NULL,
	"actor_id" text,
	"evidence_entry_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"incident_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb,
	"transitioned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lane_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"lane_key" text NOT NULL,
	"lane_name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'healthy' NOT NULL,
	"status_reason" text,
	"max_concurrent_runs" integer DEFAULT 1 NOT NULL,
	"max_manager_runs" integer DEFAULT 0 NOT NULL,
	"allow_parallel_with_dependency_proof" boolean DEFAULT false NOT NULL,
	"allow_retry" boolean DEFAULT false NOT NULL,
	"max_retry_attempts" integer DEFAULT 0 NOT NULL,
	"allowed_agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_issue_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowed_evidence_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"budget_policy_ref" text,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active_run_id" uuid,
	"active_issue_id" uuid,
	"active_agent_id" uuid,
	"stopped_by_incident_id" uuid,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_contract_revisions" ADD CONSTRAINT "agent_contract_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_contract_revisions" ADD CONSTRAINT "agent_contract_revisions_contract_id_agent_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."agent_contracts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_contract_revisions" ADD CONSTRAINT "agent_contract_revisions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_contract_revisions" ADD CONSTRAINT "agent_contract_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_contracts" ADD CONSTRAINT "agent_contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_contracts" ADD CONSTRAINT "agent_contracts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_contracts" ADD CONSTRAINT "agent_contracts_lane_policy_id_lane_policies_id_fk" FOREIGN KEY ("lane_policy_id") REFERENCES "public"."lane_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_evidence_entries" ADD CONSTRAINT "autonomy_evidence_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_evidence_entries" ADD CONSTRAINT "autonomy_evidence_entries_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_evidence_entries" ADD CONSTRAINT "autonomy_evidence_entries_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_evidence_entries" ADD CONSTRAINT "autonomy_evidence_entries_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_evidence_entries" ADD CONSTRAINT "autonomy_evidence_entries_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_incidents" ADD CONSTRAINT "autonomy_incidents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_incidents" ADD CONSTRAINT "autonomy_incidents_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_incidents" ADD CONSTRAINT "autonomy_incidents_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_incidents" ADD CONSTRAINT "autonomy_incidents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_incidents" ADD CONSTRAINT "autonomy_incidents_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_run_transitions" ADD CONSTRAINT "autonomy_run_transitions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_run_transitions" ADD CONSTRAINT "autonomy_run_transitions_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_run_transitions" ADD CONSTRAINT "autonomy_run_transitions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomy_run_transitions" ADD CONSTRAINT "autonomy_run_transitions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_policies" ADD CONSTRAINT "lane_policies_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_policies" ADD CONSTRAINT "lane_policies_active_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_policies" ADD CONSTRAINT "lane_policies_active_issue_id_issues_id_fk" FOREIGN KEY ("active_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_policies" ADD CONSTRAINT "lane_policies_active_agent_id_agents_id_fk" FOREIGN KEY ("active_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lane_policies" ADD CONSTRAINT "lane_policies_stopped_by_incident_id_autonomy_incidents_id_fk" FOREIGN KEY ("stopped_by_incident_id") REFERENCES "public"."autonomy_incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_contract_revisions_company_contract_idx" ON "agent_contract_revisions" USING btree ("company_id","contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_contract_revisions_contract_version_uq" ON "agent_contract_revisions" USING btree ("contract_id","version");--> statement-breakpoint
CREATE INDEX "agent_contract_revisions_company_agent_status_idx" ON "agent_contract_revisions" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_contract_revisions_company_status_idx" ON "agent_contract_revisions" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "agent_contract_revisions_company_lane_status_idx" ON "agent_contract_revisions" USING btree ("company_id","lane_key","status");--> statement-breakpoint
CREATE INDEX "agent_contracts_company_agent_idx" ON "agent_contracts" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "agent_contracts_company_agent_status_idx" ON "agent_contracts" USING btree ("company_id","agent_id","status");--> statement-breakpoint
CREATE INDEX "agent_contracts_company_status_idx" ON "agent_contracts" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "agent_contracts_company_lane_status_idx" ON "agent_contracts" USING btree ("company_id","lane_key","status");--> statement-breakpoint
CREATE INDEX "agent_contracts_company_lane_policy_idx" ON "agent_contracts" USING btree ("company_id","lane_policy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_contracts_company_agent_lane_name_uq" ON "agent_contracts" USING btree ("company_id","agent_id","lane_key","name");--> statement-breakpoint
CREATE INDEX "autonomy_evidence_entries_company_status_idx" ON "autonomy_evidence_entries" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "autonomy_evidence_entries_company_verdict_idx" ON "autonomy_evidence_entries" USING btree ("company_id","verdict");--> statement-breakpoint
CREATE INDEX "autonomy_evidence_entries_company_type_idx" ON "autonomy_evidence_entries" USING btree ("company_id","type");--> statement-breakpoint
CREATE INDEX "autonomy_evidence_entries_company_run_idx" ON "autonomy_evidence_entries" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "autonomy_evidence_entries_company_issue_idx" ON "autonomy_evidence_entries" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "autonomy_evidence_entries_company_agent_idx" ON "autonomy_evidence_entries" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "autonomy_evidence_entries_company_approval_idx" ON "autonomy_evidence_entries" USING btree ("company_id","approval_id");--> statement-breakpoint
CREATE INDEX "autonomy_evidence_entries_company_source_idx" ON "autonomy_evidence_entries" USING btree ("company_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "autonomy_incidents_company_status_idx" ON "autonomy_incidents" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "autonomy_incidents_company_severity_idx" ON "autonomy_incidents" USING btree ("company_id","severity");--> statement-breakpoint
CREATE INDEX "autonomy_incidents_company_type_idx" ON "autonomy_incidents" USING btree ("company_id","type");--> statement-breakpoint
CREATE INDEX "autonomy_incidents_company_run_idx" ON "autonomy_incidents" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "autonomy_incidents_company_issue_idx" ON "autonomy_incidents" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "autonomy_incidents_company_agent_idx" ON "autonomy_incidents" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "autonomy_incidents_company_lane_status_idx" ON "autonomy_incidents" USING btree ("company_id","lane_key","status");--> statement-breakpoint
CREATE INDEX "autonomy_incidents_company_source_idx" ON "autonomy_incidents" USING btree ("company_id","source_type","source_id");--> statement-breakpoint
CREATE INDEX "autonomy_incidents_company_idempotency_idx" ON "autonomy_incidents" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "autonomy_run_transitions_company_run_idx" ON "autonomy_run_transitions" USING btree ("company_id","run_id");--> statement-breakpoint
CREATE INDEX "autonomy_run_transitions_company_issue_idx" ON "autonomy_run_transitions" USING btree ("company_id","issue_id");--> statement-breakpoint
CREATE INDEX "autonomy_run_transitions_company_agent_idx" ON "autonomy_run_transitions" USING btree ("company_id","agent_id");--> statement-breakpoint
CREATE INDEX "autonomy_run_transitions_company_to_state_idx" ON "autonomy_run_transitions" USING btree ("company_id","to_state");--> statement-breakpoint
CREATE INDEX "autonomy_run_transitions_company_terminal_idx" ON "autonomy_run_transitions" USING btree ("company_id","terminal_classification");--> statement-breakpoint
CREATE INDEX "autonomy_run_transitions_company_lane_transitioned_idx" ON "autonomy_run_transitions" USING btree ("company_id","lane_key","transitioned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lane_policies_company_lane_key_uq" ON "lane_policies" USING btree ("company_id","lane_key");--> statement-breakpoint
CREATE UNIQUE INDEX "lane_policies_company_default_uq" ON "lane_policies" USING btree ("company_id") WHERE "lane_policies"."is_default" = true;--> statement-breakpoint
CREATE INDEX "lane_policies_company_status_idx" ON "lane_policies" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "lane_policies_company_active_run_idx" ON "lane_policies" USING btree ("company_id","active_run_id");--> statement-breakpoint
CREATE INDEX "lane_policies_company_active_issue_idx" ON "lane_policies" USING btree ("company_id","active_issue_id");--> statement-breakpoint
CREATE INDEX "lane_policies_company_active_agent_idx" ON "lane_policies" USING btree ("company_id","active_agent_id");