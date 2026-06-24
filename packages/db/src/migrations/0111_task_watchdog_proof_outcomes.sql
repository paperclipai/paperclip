CREATE TABLE IF NOT EXISTS "issue_watchdog_proof_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "watchdog_id" uuid NOT NULL,
  "source_issue_id" uuid NOT NULL,
  "watchdog_issue_id" uuid,
  "target_issue_id" uuid,
  "outcome" text NOT NULL,
  "method" text NOT NULL,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "result_classification" text NOT NULL,
  "redacted_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "stop_fingerprint" text NOT NULL,
  "proof_obligation_fingerprint" text NOT NULL,
  "created_by_run_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "issue_watchdog_proof_outcomes_outcome_chk"
    CHECK ("outcome" IN ('accepted', 'restored', 'deferred', 'failed', 'dismissed'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdog_proof_outcomes" ADD CONSTRAINT "issue_watchdog_proof_outcomes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdog_proof_outcomes" ADD CONSTRAINT "issue_watchdog_proof_outcomes_watchdog_id_issue_watchdogs_id_fk" FOREIGN KEY ("watchdog_id") REFERENCES "public"."issue_watchdogs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdog_proof_outcomes" ADD CONSTRAINT "issue_watchdog_proof_outcomes_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdog_proof_outcomes" ADD CONSTRAINT "issue_watchdog_proof_outcomes_watchdog_issue_id_issues_id_fk" FOREIGN KEY ("watchdog_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdog_proof_outcomes" ADD CONSTRAINT "issue_watchdog_proof_outcomes_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "issue_watchdog_proof_outcomes" ADD CONSTRAINT "issue_watchdog_proof_outcomes_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_watchdog_proof_outcomes_company_watchdog_observed_idx"
  ON "issue_watchdog_proof_outcomes" USING btree ("company_id","watchdog_id","observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issue_watchdog_proof_outcomes_company_source_idx"
  ON "issue_watchdog_proof_outcomes" USING btree ("company_id","source_issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_watchdog_proof_outcomes_unique_proof_uq"
  ON "issue_watchdog_proof_outcomes" USING btree ("company_id","watchdog_id","stop_fingerprint","proof_obligation_fingerprint");
