CREATE TABLE IF NOT EXISTS "terminal_failure_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "dedupe_key" text NOT NULL,
  "normalized_failure_cause" text NOT NULL,
  "failure_cause" text NOT NULL,
  "root_run_id" text NOT NULL,
  "run_id" text NOT NULL,
  "issue_id" uuid,
  "report_issue_id" uuid,
  "ledger_comment_id" uuid,
  "redelivery_count" integer DEFAULT 0 NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_redelivered_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "terminal_failure_ledger_company_dedupe_key_uq"
  ON "terminal_failure_ledger" USING btree ("company_id", "dedupe_key");
CREATE INDEX IF NOT EXISTS "terminal_failure_ledger_company_agent_idx"
  ON "terminal_failure_ledger" USING btree ("company_id", "agent_id");
