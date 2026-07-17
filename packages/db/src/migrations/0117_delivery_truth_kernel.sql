CREATE TABLE "delivery_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"state" text NOT NULL,
	"candidate_sha" text,
	"environment" text,
	"provider" text,
	"provider_external_id" text,
	"provider_url" text,
	"source_kind" text NOT NULL,
	"authority" text NOT NULL,
	"summary" text,
	"metadata" jsonb,
	"source_fingerprint" text,
	"source_work_product_id" uuid,
	"supersedes_event_id" uuid,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "delivery_events_stage_check" CHECK ("stage" IN ('implementation', 'ci', 'deployment', 'smoke', 'functional_qa', 'technical_acceptance', 'business_acceptance')),
	CONSTRAINT "delivery_events_state_check" CHECK ("state" IN ('unknown', 'pending', 'succeeded', 'failed', 'rolled_back', 'accepted', 'rejected', 'skipped')),
	CONSTRAINT "delivery_events_source_kind_check" CHECK ("source_kind" IN ('provider_observation', 'paperclip_action', 'user_submission', 'agent_submission', 'legacy_backfill')),
	CONSTRAINT "delivery_events_authority_check" CHECK ("authority" IN ('provider_verified', 'paperclip_verified', 'user_asserted', 'agent_claim', 'legacy_unverified')),
	CONSTRAINT "delivery_events_source_authority_pair_check" CHECK (
		("source_kind" = 'provider_observation' AND "authority" = 'provider_verified') OR
		("source_kind" = 'paperclip_action' AND "authority" = 'paperclip_verified') OR
		("source_kind" = 'user_submission' AND "authority" = 'user_asserted') OR
		("source_kind" = 'agent_submission' AND "authority" = 'agent_claim') OR
		("source_kind" = 'legacy_backfill' AND "authority" = 'legacy_unverified')
	)
);
--> statement-breakpoint
CREATE TABLE "external_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"provider" text NOT NULL,
	"stage" text NOT NULL,
	"external_id" text NOT NULL,
	"supersedes_operation_id" uuid,
	"candidate_sha" text,
	"environment" text,
	"url" text,
	"state" text DEFAULT 'unknown' NOT NULL,
	"verification_status" text DEFAULT 'unverified' NOT NULL,
	"credential_secret_id" uuid,
	"next_check_at" timestamp with time zone,
	"timeout_at" timestamp with time zone,
	"terminal_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"last_verification_error" text,
	"metadata" jsonb,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_operations_kind_check" CHECK ("kind" IN ('github_actions_workflow_run', 'cloudflare_pages_deployment', 'custom')),
	CONSTRAINT "external_operations_stage_check" CHECK ("stage" IN ('implementation', 'ci', 'deployment', 'smoke', 'functional_qa', 'technical_acceptance', 'business_acceptance')),
	CONSTRAINT "external_operations_state_check" CHECK ("state" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'unknown')),
	CONSTRAINT "external_operations_verification_check" CHECK ("verification_status" IN ('unverified', 'verified', 'mismatch', 'error'))
);
--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_source_work_product_id_issue_work_products_id_fk" FOREIGN KEY ("source_work_product_id") REFERENCES "public"."issue_work_products"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_supersedes_event_id_delivery_events_id_fk" FOREIGN KEY ("supersedes_event_id") REFERENCES "public"."delivery_events"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "delivery_events" ADD CONSTRAINT "delivery_events_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "external_operations" ADD CONSTRAINT "external_operations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "external_operations" ADD CONSTRAINT "external_operations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "external_operations" ADD CONSTRAINT "external_operations_supersedes_operation_id_external_operations_id_fk" FOREIGN KEY ("supersedes_operation_id") REFERENCES "public"."external_operations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "external_operations" ADD CONSTRAINT "external_operations_credential_secret_id_company_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "external_operations" ADD CONSTRAINT "external_operations_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "external_operations" ADD CONSTRAINT "external_operations_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "delivery_events_company_issue_created_idx" ON "delivery_events" USING btree ("company_id", "issue_id", "created_at", "id");
--> statement-breakpoint
CREATE INDEX "delivery_events_company_issue_stage_observed_idx" ON "delivery_events" USING btree ("company_id", "issue_id", "stage", "observed_at");
--> statement-breakpoint
CREATE INDEX "delivery_events_company_provider_external_idx" ON "delivery_events" USING btree ("company_id", "provider", "provider_external_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_events_legacy_work_product_uq" ON "delivery_events" USING btree ("company_id", "issue_id", "source_work_product_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_events_source_fingerprint_uq" ON "delivery_events" USING btree ("company_id", "issue_id", "source_fingerprint");
--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_events_supersedes_once_uq" ON "delivery_events" USING btree ("company_id", "issue_id", "supersedes_event_id") WHERE "supersedes_event_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "external_operations_company_issue_updated_idx" ON "external_operations" USING btree ("company_id", "issue_id", "updated_at");
--> statement-breakpoint
CREATE INDEX "external_operations_verification_due_idx" ON "external_operations" USING btree ("verification_status", "next_check_at");
--> statement-breakpoint
CREATE INDEX "external_operations_active_due_idx" ON "external_operations" USING btree ("next_check_at") WHERE "terminal_at" IS NULL AND "next_check_at" IS NOT NULL AND "state" NOT IN ('succeeded', 'failed', 'cancelled', 'timed_out');
--> statement-breakpoint
CREATE UNIQUE INDEX "external_operations_issue_provider_external_uq" ON "external_operations" USING btree ("company_id", "issue_id", "provider", "kind", "external_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "external_operations_supersedes_once_uq" ON "external_operations" USING btree ("supersedes_operation_id") WHERE "supersedes_operation_id" IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_delivery_event_mutation() RETURNS trigger AS $$
BEGIN
	-- Referential actions may remove a ledger together with its owning tenant or
	-- issue. Direct update/delete attempts are rejected: corrections append a
	-- new event and point to the prior event through supersedes_event_id.
	IF pg_trigger_depth() > 1 THEN
		IF TG_OP = 'UPDATE' THEN
			RETURN NEW;
		END IF;
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'delivery_events is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "delivery_events_append_only" BEFORE UPDATE OR DELETE ON "delivery_events"
	FOR EACH ROW EXECUTE FUNCTION prevent_delivery_event_mutation();
