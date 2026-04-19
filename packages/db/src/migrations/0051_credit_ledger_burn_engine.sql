-- Credit Ledger & Burn Engine schema
-- Implements WS-2: append-only credit ledger and configurable burn rate table

CREATE TYPE "credit_event_type" AS ENUM (
  'subscription_grant',
  'purchase',
  'burn',
  'refund',
  'adjustment'
);

CREATE TABLE IF NOT EXISTS "credit_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "companies"("id"),
  "event_type" "credit_event_type" NOT NULL,
  -- positive = credit, negative = debit
  "amount" integer NOT NULL,
  "billing_period_start" timestamp with time zone,
  "billing_period_end" timestamp with time zone,
  "metadata" jsonb,
  -- tied to agent run ID; prevents duplicate charges
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_idempotency_key_uq"
  ON "credit_ledger" ("idempotency_key");

CREATE INDEX IF NOT EXISTS "credit_ledger_account_created_idx"
  ON "credit_ledger" ("account_id", "created_at");

CREATE INDEX IF NOT EXISTS "credit_ledger_account_event_type_idx"
  ON "credit_ledger" ("account_id", "event_type");

CREATE INDEX IF NOT EXISTS "credit_ledger_account_billing_period_idx"
  ON "credit_ledger" ("account_id", "billing_period_start", "billing_period_end");

CREATE TABLE IF NOT EXISTS "credit_burn_rates" (
  "action_type" text PRIMARY KEY NOT NULL,
  "credits_min" integer NOT NULL,
  "credits_max" integer NOT NULL,
  "credits_default" integer NOT NULL,
  "description" text,
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Seed default burn rates per IUN-99 architecture
INSERT INTO "credit_burn_rates" ("action_type", "credits_min", "credits_max", "credits_default", "description")
VALUES
  ('heartbeat_light',          1,  1,  1, 'Light heartbeat with minimal tool use'),
  ('heartbeat_complex',        3,  5,  3, 'Heartbeat with complex tool use'),
  ('multi_agent_orchestration',10, 25, 10, 'Multi-agent orchestration run'),
  ('approval_workflow',         5,  5,  5, 'Approval workflow action'),
  ('external_api_call',         2,  2,  2, 'External API call made by agent')
ON CONFLICT ("action_type") DO NOTHING;
