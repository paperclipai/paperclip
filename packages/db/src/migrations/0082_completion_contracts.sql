CREATE TABLE IF NOT EXISTS "completion_contract_evaluations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "contract" text NOT NULL,
  "result" text NOT NULL,
  "missing" text,
  "evaluator" text NOT NULL,
  "agent_id" uuid,
  "evaluated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "cce_issue_idx" ON "completion_contract_evaluations" ("issue_id");
CREATE INDEX IF NOT EXISTS "cce_company_idx" ON "completion_contract_evaluations" ("company_id");
CREATE INDEX IF NOT EXISTS "cce_evaluated_at_idx" ON "completion_contract_evaluations" ("evaluated_at");

CREATE TABLE IF NOT EXISTS "completion_contract_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "contract" text NOT NULL,
  "reason" text NOT NULL,
  "approver" text NOT NULL,
  "authorized_by_user_id" uuid,
  "authorized_by_agent_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "cco_issue_idx" ON "completion_contract_overrides" ("issue_id");
CREATE INDEX IF NOT EXISTS "cco_company_idx" ON "completion_contract_overrides" ("company_id");
