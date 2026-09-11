CREATE TABLE "recovery_engineer_procedure_reuses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"procedure_id" uuid NOT NULL,
	"source_issue_id" uuid NOT NULL,
	"source_generation_key" text NOT NULL,
	"failure_fingerprint" text NOT NULL,
	"evidence_key" text NOT NULL,
	"status" text DEFAULT 'applied' NOT NULL,
	"refusal_reason" text,
	"applicability" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"applied_by_agent_id" uuid,
	"applied_by_run_id" uuid,
	"applied_by_user_id" text,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome_at" timestamp with time zone,
	"outcome_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_engineer_procedure_reuses_status_check" CHECK ("recovery_engineer_procedure_reuses"."status" in ('applied', 'succeeded', 'failed', 'refused'))
);
--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD COLUMN "recovered_run_id" uuid;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD COLUMN "recovered_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD COLUMN "resume_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD COLUMN "resume_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD COLUMN "resume_last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD COLUMN "resume_dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD COLUMN "resume_failure_reason" text;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD COLUMN "superseded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD COLUMN "superseded_reason" text;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD COLUMN "superseded_by_source_id" uuid;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incidents" ADD COLUMN "outcome" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_engineer_incidents" ADD COLUMN "outcome_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedures" ADD COLUMN "applicability" jsonb;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedures" ADD COLUMN "failed_reuse_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedures" ADD COLUMN "last_reuse_outcome" text;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedures" ADD COLUMN "last_reused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedures" ADD COLUMN "invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedures" ADD COLUMN "invalidated_reason" text;--> statement-breakpoint
ALTER TABLE "recovery_engineer_verifications" ADD COLUMN "duplicate_of_verification_id" uuid;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedure_reuses" ADD CONSTRAINT "recovery_engineer_procedure_reuses_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedure_reuses" ADD CONSTRAINT "recovery_engineer_procedure_reuses_incident_id_recovery_engineer_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."recovery_engineer_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedure_reuses" ADD CONSTRAINT "recovery_engineer_procedure_reuses_procedure_id_recovery_engineer_procedures_id_fk" FOREIGN KEY ("procedure_id") REFERENCES "public"."recovery_engineer_procedures"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedure_reuses" ADD CONSTRAINT "recovery_engineer_procedure_reuses_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_engineer_procedure_reuses" ADD CONSTRAINT "recovery_engineer_procedure_reuses_applied_by_agent_id_agents_id_fk" FOREIGN KEY ("applied_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_engineer_procedure_reuses_key_uq" ON "recovery_engineer_procedure_reuses" USING btree ("company_id","procedure_id","incident_id","source_issue_id","source_generation_key","evidence_key");--> statement-breakpoint
CREATE INDEX "recovery_engineer_procedure_reuses_company_status_idx" ON "recovery_engineer_procedure_reuses" USING btree ("company_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "recovery_engineer_procedure_reuses_procedure_applied_idx" ON "recovery_engineer_procedure_reuses" USING btree ("procedure_id","applied_at");--> statement-breakpoint
CREATE INDEX "recovery_engineer_incident_sources_company_open_idx" ON "recovery_engineer_incident_sources" USING btree ("company_id","superseded_at","recovered_at","resume_claimed_at");--> statement-breakpoint
CREATE INDEX "recovery_engineer_incidents_company_outcome_idx" ON "recovery_engineer_incidents" USING btree ("company_id","outcome","updated_at");--> statement-breakpoint
ALTER TABLE "recovery_engineer_incident_sources" ADD CONSTRAINT "recovery_engineer_incident_sources_close_exclusivity_check" CHECK (not ("recovery_engineer_incident_sources"."recovered_at" is not null and "recovery_engineer_incident_sources"."superseded_at" is not null));