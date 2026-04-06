-- LLM API Keys management table
-- Stores provider API keys that can be assigned to agents or selected by the CEO per task
CREATE TABLE IF NOT EXISTS "llm_api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "name" text NOT NULL,
  "provider" text NOT NULL DEFAULT 'anthropic',
  "api_key_encrypted" text NOT NULL,
  "model_filter" text,
  "is_default" boolean NOT NULL DEFAULT false,
  "is_active" boolean NOT NULL DEFAULT true,
  "priority" integer NOT NULL DEFAULT 0,
  "monthly_budget_usd" numeric(10, 2),
  "current_month_spend_usd" numeric(10, 2) NOT NULL DEFAULT 0,
  "total_spend_usd" numeric(10, 2) NOT NULL DEFAULT 0,
  "total_requests" integer NOT NULL DEFAULT 0,
  "last_used_at" timestamp with time zone,
  "last_error" text,
  "last_error_at" timestamp with time zone,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "llm_api_keys_company_idx" ON "llm_api_keys" ("company_id");
CREATE INDEX IF NOT EXISTS "llm_api_keys_provider_idx" ON "llm_api_keys" ("company_id", "provider");
CREATE INDEX IF NOT EXISTS "llm_api_keys_default_idx" ON "llm_api_keys" ("company_id", "is_default") WHERE "is_default" = true;

-- Agent-to-key assignment table
-- Allows assigning specific API keys to specific agents
CREATE TABLE IF NOT EXISTS "agent_llm_key_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "llm_api_key_id" uuid NOT NULL REFERENCES "llm_api_keys"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "assigned_by" text NOT NULL DEFAULT 'manual',
  "assigned_at" timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE("agent_id", "llm_api_key_id")
);

CREATE INDEX IF NOT EXISTS "agent_llm_key_assignments_agent_idx" ON "agent_llm_key_assignments" ("agent_id");
CREATE INDEX IF NOT EXISTS "agent_llm_key_assignments_key_idx" ON "agent_llm_key_assignments" ("llm_api_key_id");
