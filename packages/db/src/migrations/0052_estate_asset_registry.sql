-- Estate Management MVP: Asset Registry & Financial Aggregation schema
-- IUN-103 deliverables: estate_assets, estate_financial_accounts, estate_balance_history

CREATE TYPE "estate_asset_type" AS ENUM (
  'real_estate',
  'investment',
  'vehicle',
  'personal_property',
  'digital_asset',
  'other'
);

CREATE TABLE IF NOT EXISTS "estate_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "asset_type" "estate_asset_type" NOT NULL,
  "category" text,
  "tags" text[],
  -- entity_id links to a trust/LLC/individual (stored as text ref, no FK — entity table TBD)
  "entity_id" text,
  "current_value_cents" numeric(20, 0),
  "valuation_date" timestamp with time zone,
  -- type-specific metadata (address/sqft for real_estate; ticker/shares for investment; etc.)
  "type_metadata" jsonb,
  "notes" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "estate_assets_company_user_idx"
  ON "estate_assets" ("company_id", "user_id");
CREATE INDEX IF NOT EXISTS "estate_assets_company_type_idx"
  ON "estate_assets" ("company_id", "asset_type");
CREATE INDEX IF NOT EXISTS "estate_assets_entity_idx"
  ON "estate_assets" ("entity_id");

CREATE TYPE "financial_account_type" AS ENUM (
  'checking',
  'savings',
  'investment',
  'retirement',
  'credit',
  'loan',
  'mortgage',
  'other'
);

CREATE TABLE IF NOT EXISTS "estate_financial_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "user_id" text NOT NULL,
  "name" text NOT NULL,
  "institution_name" text,
  "account_type" "financial_account_type" NOT NULL,
  "entity_id" text,
  -- Plaid fields; null for manually entered accounts
  "plaid_access_token" text,
  "plaid_item_id" text,
  "plaid_account_id" text,
  "balance_cents" numeric(20, 0),
  "balance_updated_at" timestamp with time zone,
  "is_manual" boolean NOT NULL DEFAULT false,
  "metadata" jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "estate_financial_accounts_company_user_idx"
  ON "estate_financial_accounts" ("company_id", "user_id");
CREATE INDEX IF NOT EXISTS "estate_financial_accounts_plaid_item_idx"
  ON "estate_financial_accounts" ("plaid_item_id");
CREATE INDEX IF NOT EXISTS "estate_financial_accounts_entity_idx"
  ON "estate_financial_accounts" ("entity_id");

CREATE TABLE IF NOT EXISTS "estate_balance_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_id" uuid NOT NULL REFERENCES "estate_financial_accounts"("id"),
  "balance_cents" numeric(20, 0) NOT NULL,
  "recorded_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "estate_balance_history_account_recorded_at_idx"
  ON "estate_balance_history" ("account_id", "recorded_at");
