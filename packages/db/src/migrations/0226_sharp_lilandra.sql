CREATE TABLE "completion_contracts" (
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
CREATE TABLE "native_run_finalizations" (
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
CREATE TABLE "native_run_results" (
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
CREATE TABLE "status_decision_effects" (
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
CREATE TABLE "status_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
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
CREATE TABLE "work_assessments" (
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
ALTER TABLE "heartbeat_run_events" ADD COLUMN "source_instance_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD COLUMN "source_event_id" text;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD COLUMN "source_seq" bigint;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD COLUMN "source_payload_sha256" text;--> statement-breakpoint
ALTER TABLE "heartbeat_run_events" ADD COLUMN "protocol_schema_version" integer;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "runtime_mode" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "runtime_mode_resolver_version" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "runtime_mode_reason" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "runtime_mode_resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "runner_profile_json" jsonb;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "runner_instance_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "native_session_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "driver_kind" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "driver_version" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "completion_contract_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "completion_contract_sha256" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "next_event_seq" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "native_phase" text;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN "native_phase_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "status_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "last_status_decision_id" uuid;--> statement-breakpoint
-- Historical event writers computed max(seq) outside their insert transaction. Preserve every
-- existing unique cursor and the first row at each duplicated cursor. Only later colliding rows
-- move above the run's pre-migration maximum, in deterministic legacy order.
WITH ranked AS (
	SELECT
		"id",
		"run_id",
		"seq",
		"created_at",
		row_number() OVER (
			PARTITION BY "run_id", "seq"
			ORDER BY "created_at", "id"
		) AS "duplicate_ordinal",
		max("seq") OVER (PARTITION BY "run_id") AS "old_run_max"
	FROM "heartbeat_run_events"
), duplicate_repairs AS (
	SELECT
		"id",
		"old_run_max" + row_number() OVER (
			PARTITION BY "run_id"
			ORDER BY "seq", "created_at", "id"
		) AS "new_seq"
	FROM ranked
	WHERE "duplicate_ordinal" > 1
)
UPDATE "heartbeat_run_events" AS event
SET "seq" = duplicate_repairs."new_seq"
FROM duplicate_repairs
WHERE event."id" = duplicate_repairs."id";--> statement-breakpoint
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
CREATE TRIGGER paperclip_issue_status_version_trigger
BEFORE UPDATE OF "status" ON "issues"
FOR EACH ROW EXECUTE FUNCTION paperclip_bump_issue_status_version();--> statement-breakpoint
ALTER TABLE "completion_contracts" ADD CONSTRAINT "completion_contracts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_contracts" ADD CONSTRAINT "completion_contracts_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_run_finalizations" ADD CONSTRAINT "native_run_finalizations_result_id_native_run_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."native_run_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "native_run_results" ADD CONSTRAINT "native_run_results_completion_contract_id_completion_contracts_id_fk" FOREIGN KEY ("completion_contract_id") REFERENCES "public"."completion_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_decision_effects" ADD CONSTRAINT "status_decision_effects_decision_id_status_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."status_decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_decisions" ADD CONSTRAINT "status_decisions_assessment_id_work_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."work_assessments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_contract_id_completion_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."completion_contracts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_result_id_native_run_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."native_run_results"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_assessments" ADD CONSTRAINT "work_assessments_trigger_actor_company_id_companies_id_fk" FOREIGN KEY ("trigger_actor_company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "completion_contracts_issue_revision_uq" ON "completion_contracts" USING btree ("issue_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "completion_contracts_issue_hash_uq" ON "completion_contracts" USING btree ("issue_id","canonical_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "native_run_results_run_fingerprint_uq" ON "native_run_results" USING btree ("run_id","server_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "native_run_results_run_caller_result_uq" ON "native_run_results" USING btree ("run_id","caller_result_id");--> statement-breakpoint
CREATE UNIQUE INDEX "native_run_results_run_caller_dedupe_uq" ON "native_run_results" USING btree ("run_id","caller_dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "status_decision_effects_decision_ordinal_uq" ON "status_decision_effects" USING btree ("decision_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "status_decision_effects_company_idempotency_uq" ON "status_decision_effects" USING btree ("company_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "status_decisions_company_issue_version_uq" ON "status_decisions" USING btree ("company_id","issue_id","decision_version");--> statement-breakpoint
CREATE UNIQUE INDEX "status_decisions_company_assessment_uq" ON "status_decisions" USING btree ("company_id","assessment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "status_decisions_company_issue_digest_uq" ON "status_decisions" USING btree ("company_id","issue_id","decision_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "work_assessments_company_issue_input_uq" ON "work_assessments" USING btree ("company_id","issue_id","input_digest");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: duplicate rows are deterministically resequenced above before this invariant is enabled in the same transaction.
CREATE UNIQUE INDEX "heartbeat_run_events_run_seq_uq" ON "heartbeat_run_events" USING btree ("run_id","seq");--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: nullable native source IDs mean historical rows need no backfill and the invariant must commit atomically with the new columns.
CREATE UNIQUE INDEX "heartbeat_run_events_run_source_event_uq" ON "heartbeat_run_events" USING btree ("run_id","source_event_id") WHERE "heartbeat_run_events"."source_event_id" is not null;--> statement-breakpoint
-- paperclip:migration-safety-ignore large-create-index-not-concurrently: nullable native source sequence fields mean historical rows need no backfill and the invariant must commit atomically with the new columns.
CREATE UNIQUE INDEX "heartbeat_run_events_run_source_seq_uq" ON "heartbeat_run_events" USING btree ("run_id","source_instance_id","source_seq") WHERE "heartbeat_run_events"."source_instance_id" is not null and "heartbeat_run_events"."source_seq" is not null;
