CREATE TABLE IF NOT EXISTS "completion_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"schema_version" text NOT NULL,
	"policy_version" text NOT NULL,
	"risk" text NOT NULL,
	"completion_authority" text NOT NULL,
	"incomplete_criteria_policy" text NOT NULL,
	"contract_json" jsonb NOT NULL,
	"canonical_sha256" text NOT NULL,
	"created_by_actor_type" text NOT NULL,
	"created_by_actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"supersedes_contract_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "native_run_finalizations" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"result_id" uuid,
	"assessment_id" uuid,
	"decision_id" uuid,
	"failure_code" text,
	"failure_detail" jsonb,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "native_run_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"turn_id" text,
	"completion_contract_id" uuid NOT NULL,
	"caller_result_id" text,
	"caller_dedupe_key" text,
	"server_fingerprint" text NOT NULL,
	"schema_status" text NOT NULL,
	"rejection_code" text,
	"result_json" jsonb NOT NULL,
	"canonical_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "status_decision_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"decision_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"effect_kind" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"delivery_state" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "status_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"assessment_id" uuid NOT NULL,
	"decision_version" bigint NOT NULL,
	"policy_version" text NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	"reason_code" text NOT NULL,
	"decision_json" jsonb NOT NULL,
	"decision_digest" text NOT NULL,
	"application_state" text DEFAULT 'proposed' NOT NULL,
	"supersedes_decision_id" uuid,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "work_assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"turn_id" text,
	"contract_id" uuid NOT NULL,
	"result_id" uuid NOT NULL,
	"trigger_kind" text NOT NULL,
	"trigger_ref" text,
	"trigger_capability" text,
	"trigger_actor_company_id" uuid NOT NULL,
	"prior_issue_status" text NOT NULL,
	"prior_status_version" bigint NOT NULL,
	"prior_decision_id" uuid,
	"policy_version" text NOT NULL,
	"assessment_json" jsonb NOT NULL,
	"input_digest" text NOT NULL,
	"supersedes_assessment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ALTER COLUMN "seq" SET DATA TYPE bigint;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD COLUMN IF NOT EXISTS "source_instance_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD COLUMN IF NOT EXISTS "source_event_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD COLUMN IF NOT EXISTS "source_seq" bigint;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD COLUMN IF NOT EXISTS "source_payload_sha256" text;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD COLUMN IF NOT EXISTS "protocol_schema_version" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "runtime_mode" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "runtime_mode_resolver_version" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "runtime_mode_reason" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "runtime_mode_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "runner_profile_json" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "runner_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "native_session_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "native_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "driver_kind" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "driver_version" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "completion_contract_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "completion_contract_sha256" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "next_event_seq" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "native_phase" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "native_phase_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "status_decisions" ADD COLUMN IF NOT EXISTS "run_id" uuid;--> statement-breakpoint
ALTER TABLE "status_decisions" ALTER COLUMN "run_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "status_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "last_status_decision_id" uuid;--> statement-breakpoint
UPDATE "heartbeat_runs" AS run
SET "next_event_seq" = COALESCE((
	SELECT max(event."seq") + 1
	FROM "heartbeat_run_events" AS event
	WHERE event."run_id" = run."id"
), 1);--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_bump_issue_status_version()
RETURNS trigger AS $$
BEGIN
	IF NEW."status" IS DISTINCT FROM OLD."status" THEN
		NEW."status_version" := OLD."status_version" + 1;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_issue_status_version_trigger ON "issues";--> statement-breakpoint
CREATE TRIGGER paperclip_issue_status_version_trigger
BEFORE UPDATE OF "status" ON "issues"
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_status_version();--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "completion_contracts" ADD CONSTRAINT "completion_contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "completion_contracts" ADD CONSTRAINT "completion_contracts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_result_id_native_run_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."native_run_results"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_completion_contract_id_completion_contracts_id_fk" FOREIGN KEY ("completion_contract_id") REFERENCES "public"."completion_contracts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_decision_id_status_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."status_decisions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_assessment_id_work_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."work_assessments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_contract_id_completion_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."completion_contracts"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_result_id_native_run_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."native_run_results"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_trigger_actor_company_id_companies_id_fk" FOREIGN KEY ("trigger_actor_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "completion_contracts_issue_revision_uq" ON "completion_contracts" USING btree ("issue_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "completion_contracts_issue_hash_uq" ON "completion_contracts" USING btree ("issue_id","canonical_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "native_run_results_run_fingerprint_uq" ON "native_run_results" USING btree ("run_id","server_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "native_run_results_run_caller_result_uq" ON "native_run_results" USING btree ("run_id","caller_result_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "native_run_results_run_caller_dedupe_uq" ON "native_run_results" USING btree ("run_id","caller_dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "status_decision_effects_decision_ordinal_uq" ON "status_decision_effects" USING btree ("decision_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "status_decision_effects_company_idempotency_uq" ON "status_decision_effects" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "status_decisions_company_issue_version_uq" ON "status_decisions" USING btree ("company_id","issue_id","decision_version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "status_decisions_company_assessment_uq" ON "status_decisions" USING btree ("company_id","assessment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "status_decisions_company_issue_digest_uq" ON "status_decisions" USING btree ("company_id","issue_id","decision_digest");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_assessments_company_issue_input_uq" ON "work_assessments" USING btree ("company_id","issue_id","input_digest");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: nullable native source IDs mean historical rows need no backfill and the invariant must commit atomically with the new columns.
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_run_events_run_source_event_uq" ON "heartbeat_run_events" USING btree ("run_id","source_event_id") WHERE "heartbeat_run_events"."source_event_id" is not null;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: nullable native source sequence fields mean historical rows need no backfill and the invariant must commit atomically with the new columns.
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_run_events_run_source_seq_uq" ON "heartbeat_run_events" USING btree ("run_id","source_instance_id","source_seq") WHERE "heartbeat_run_events"."source_instance_id" is not null and "heartbeat_run_events"."source_seq" is not null;
--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the primary key already makes this ownership tuple unique; this supporting index only enables composite foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS "issues_company_id_uq" ON "issues" USING btree ("company_id","id");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the primary key already makes this ownership tuple unique; this supporting index only enables composite foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_runs_company_native_issue_id_uq" ON "heartbeat_runs" USING btree ("company_id","native_issue_id","id");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: the primary key already makes this ownership tuple unique; this supporting index only enables composite foreign keys.
CREATE UNIQUE INDEX IF NOT EXISTS "heartbeat_runs_company_native_issue_contract_id_uq" ON "heartbeat_runs" USING btree ("company_id","native_issue_id","id","completion_contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "completion_contracts_company_issue_id_uq" ON "completion_contracts" USING btree ("company_id","issue_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "native_run_results_company_issue_run_id_uq" ON "native_run_results" USING btree ("company_id","issue_id","run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "work_assessments_company_issue_run_id_uq" ON "work_assessments" USING btree ("company_id","issue_id","run_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "status_decisions_company_issue_id_uq" ON "status_decisions" USING btree ("company_id","issue_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "status_decisions_company_issue_run_assessment_id_uq" ON "status_decisions" USING btree ("company_id","issue_id","run_id","assessment_id","id");--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "completion_contracts" ADD CONSTRAINT "completion_contracts_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "completion_contracts" ADD CONSTRAINT "completion_contracts_supersedes_owner_fk" FOREIGN KEY ("company_id","issue_id","supersedes_contract_id") REFERENCES "public"."completion_contracts"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_run_contract_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","completion_contract_id") REFERENCES "public"."heartbeat_runs"("company_id","native_issue_id","id","completion_contract_id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_completion_contract_owner_fk" FOREIGN KEY ("company_id","issue_id","completion_contract_id") REFERENCES "public"."completion_contracts"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_run_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","native_issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_contract_owner_fk" FOREIGN KEY ("company_id","issue_id","contract_id") REFERENCES "public"."completion_contracts"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_result_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","result_id") REFERENCES "public"."native_run_results"("company_id","issue_id","run_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_supersedes_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","supersedes_assessment_id") REFERENCES "public"."work_assessments"("company_id","issue_id","run_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_assessment_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","assessment_id") REFERENCES "public"."work_assessments"("company_id","issue_id","run_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_supersedes_owner_fk" FOREIGN KEY ("company_id","issue_id","supersedes_decision_id") REFERENCES "public"."status_decisions"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_decision_owner_fk" FOREIGN KEY ("company_id","issue_id","decision_id") REFERENCES "public"."status_decisions"("company_id","issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_issue_company_fk" FOREIGN KEY ("company_id","issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_run_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id") REFERENCES "public"."heartbeat_runs"("company_id","native_issue_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_result_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","result_id") REFERENCES "public"."native_run_results"("company_id","issue_id","run_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_assessment_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","assessment_id") REFERENCES "public"."work_assessments"("company_id","issue_id","run_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_decision_owner_fk" FOREIGN KEY ("company_id","issue_id","run_id","assessment_id","decision_id") REFERENCES "public"."status_decisions"("company_id","issue_id","run_id","assessment_id","id") ON DELETE no action ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_assessment_requires_result_check" CHECK ("assessment_id" is null or "result_id" is not null);
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_decision_requires_assessment_check" CHECK ("decision_id" is null or "assessment_id" is not null);
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_trigger_actor_company_check" CHECK ("trigger_actor_company_id" = "company_id");
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
