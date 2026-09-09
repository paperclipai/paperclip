CREATE TABLE "recovery_engineer_configs" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"agent_id" uuid NOT NULL,
	"repair_agent_id" uuid NOT NULL,
	"reviewer_agent_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repair_project_ids" jsonb,
	"max_attempts" integer DEFAULT 1 NOT NULL,
	"sweep_interval_sec" integer DEFAULT 300 NOT NULL,
	"last_sweep_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_engineer_configs_attempts_check" CHECK ("recovery_engineer_configs"."max_attempts" = 1),
	CONSTRAINT "recovery_engineer_configs_interval_check" CHECK ("recovery_engineer_configs"."sweep_interval_sec" = 300),
	CONSTRAINT "recovery_engineer_configs_distinct_agents_check" CHECK ("recovery_engineer_configs"."agent_id" <> "recovery_engineer_configs"."repair_agent_id"
        and "recovery_engineer_configs"."agent_id" <> "recovery_engineer_configs"."reviewer_agent_id"
        and "recovery_engineer_configs"."repair_agent_id" <> "recovery_engineer_configs"."reviewer_agent_id")
);
--> statement-breakpoint
CREATE TABLE "recovery_engineer_incident_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"source_run_id" uuid,
	"generation_key" text NOT NULL,
	"original_owner_agent_id" uuid,
	"original_owner_user_id" text,
	"source_status" text NOT NULL,
	"source_status_version" bigint NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"checkout_run_id" uuid,
	"execution_run_id" uuid,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recovered_at" timestamp with time zone,
	"resume_claimed_at" timestamp with time zone,
	"resumed_at" timestamp with time zone,
	"resumed_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_engineer_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"failure_fingerprint" text NOT NULL,
	"status" text DEFAULT 'suspected' NOT NULL,
	"classification" text,
	"hypothesis" text,
	"root_cause" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"maintenance_issue_id" uuid,
	"diagnosis_attempt_count" integer DEFAULT 0 NOT NULL,
	"diagnosis_run_id" uuid,
	"diagnosis_requested_at" timestamp with time zone,
	"board_escalated_at" timestamp with time zone,
	"board_escalation_reason" text,
	"repair_target" text,
	"repair_project_id" uuid,
	"repair_issue_id" uuid,
	"repair_run_id" uuid,
	"repair_commit" text,
	"verified_verification_id" uuid,
	"verified_review_run_id" uuid,
	"verified_at" timestamp with time zone,
	"activated_repair_commit" text,
	"activation_evidence" text,
	"activated_by_user_id" text,
	"activated_at" timestamp with time zone,
	"resumed_source_issue_id" uuid,
	"resumed_run_id" uuid,
	"resumed_at" timestamp with time zone,
	"suspected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_engineer_incidents_diagnosis_attempts_check" CHECK ("recovery_engineer_incidents"."diagnosis_attempt_count" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "recovery_engineer_procedures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"title" text NOT NULL,
	"preconditions" jsonb NOT NULL,
	"steps" jsonb NOT NULL,
	"success_check" text NOT NULL,
	"stop_conditions" jsonb NOT NULL,
	"rollback" text NOT NULL,
	"evidence_run_id" uuid NOT NULL,
	"repair_commit" text NOT NULL,
	"failure_fingerprint" text NOT NULL,
	"classification" text,
	"proposed_by_agent_id" uuid,
	"proposed_by_run_id" uuid,
	"reviewed_by_user_id" text,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_engineer_procedures_status_check" CHECK ("recovery_engineer_procedures"."status" in ('proposed', 'reviewed', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "recovery_engineer_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"repair_issue_id" uuid NOT NULL,
	"review_run_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"repair_commit" text NOT NULL,
	"reproduction_command" text NOT NULL,
	"reproduction_result" text NOT NULL,
	"failure_reason" text,
	"submitted_by_agent_id" uuid,
	"submitted_by_user_id" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_engineer_verifications_status_check" CHECK ("recovery_engineer_verifications"."status" in ('pending', 'verified', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "recovery_engineer_configs" ADD CONSTRAINT "recovery_engineer_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_configs" ADD CONSTRAINT "recovery_engineer_configs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_configs" ADD CONSTRAINT "recovery_engineer_configs_repair_agent_id_agents_id_fk" FOREIGN KEY ("repair_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_configs" ADD CONSTRAINT "recovery_engineer_configs_reviewer_agent_id_agents_id_fk" FOREIGN KEY ("reviewer_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_configs" ADD CONSTRAINT "recovery_engineer_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD CONSTRAINT "recovery_engineer_incident_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD CONSTRAINT "recovery_engineer_incident_sources_incident_id_recovery_engineer_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."recovery_engineer_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD CONSTRAINT "recovery_engineer_incident_sources_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD CONSTRAINT "recovery_engineer_incident_sources_original_owner_agent_id_agents_id_fk" FOREIGN KEY ("original_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incidents" ADD CONSTRAINT "recovery_engineer_incidents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incidents" ADD CONSTRAINT "recovery_engineer_incidents_maintenance_issue_id_issues_id_fk" FOREIGN KEY ("maintenance_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incidents" ADD CONSTRAINT "recovery_engineer_incidents_repair_project_id_projects_id_fk" FOREIGN KEY ("repair_project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incidents" ADD CONSTRAINT "recovery_engineer_incidents_repair_issue_id_issues_id_fk" FOREIGN KEY ("repair_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incidents" ADD CONSTRAINT "recovery_engineer_incidents_resumed_source_issue_id_issues_id_fk" FOREIGN KEY ("resumed_source_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedures" ADD CONSTRAINT "recovery_engineer_procedures_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedures" ADD CONSTRAINT "recovery_engineer_procedures_incident_id_recovery_engineer_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."recovery_engineer_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedures" ADD CONSTRAINT "recovery_engineer_procedures_proposed_by_agent_id_agents_id_fk" FOREIGN KEY ("proposed_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_verifications" ADD CONSTRAINT "recovery_engineer_verifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_verifications" ADD CONSTRAINT "recovery_engineer_verifications_incident_id_recovery_engineer_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."recovery_engineer_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_verifications" ADD CONSTRAINT "recovery_engineer_verifications_repair_issue_id_issues_id_fk" FOREIGN KEY ("repair_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_verifications" ADD CONSTRAINT "recovery_engineer_verifications_submitted_by_agent_id_agents_id_fk" FOREIGN KEY ("submitted_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_engineer_incident_sources_incident_source_generation_uq" ON "recovery_engineer_incident_sources" USING btree ("incident_id","source_issue_id","generation_key");--> statement-breakpoint
CREATE INDEX "recovery_engineer_incident_sources_company_source_idx" ON "recovery_engineer_incident_sources" USING btree ("company_id","source_issue_id","observed_at");--> statement-breakpoint
CREATE INDEX "recovery_engineer_incident_sources_incident_observed_idx" ON "recovery_engineer_incident_sources" USING btree ("incident_id","observed_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_engineer_incidents_company_fingerprint_uq" ON "recovery_engineer_incidents" USING btree ("company_id","failure_fingerprint");--> statement-breakpoint
CREATE INDEX "recovery_engineer_incidents_company_status_idx" ON "recovery_engineer_incidents" USING btree ("company_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "recovery_engineer_incidents_maintenance_issue_idx" ON "recovery_engineer_incidents" USING btree ("company_id","maintenance_issue_id");--> statement-breakpoint
CREATE INDEX "recovery_engineer_incidents_repair_issue_idx" ON "recovery_engineer_incidents" USING btree ("company_id","repair_issue_id");--> statement-breakpoint
CREATE INDEX "recovery_engineer_procedures_company_status_idx" ON "recovery_engineer_procedures" USING btree ("company_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "recovery_engineer_procedures_incident_idx" ON "recovery_engineer_procedures" USING btree ("incident_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_engineer_verifications_company_review_run_uq" ON "recovery_engineer_verifications" USING btree ("company_id","review_run_id");--> statement-breakpoint
CREATE INDEX "recovery_engineer_verifications_incident_status_idx" ON "recovery_engineer_verifications" USING btree ("incident_id","status","updated_at");