-- Phase 2: Enhanced Asset Tracking detail tables
-- IUN-318 Priority 1

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "insurance_policy_type" AS ENUM (
  'term', 'whole_life', 'universal_life', 'variable_life', 'annuity', 'other'
);

CREATE TYPE "premium_frequency" AS ENUM (
  'monthly', 'quarterly', 'semi_annual', 'annual'
);

CREATE TYPE "retirement_account_type" AS ENUM (
  'traditional_ira', 'roth_ira', '401k', 'roth_401k',
  '403b', 'roth_403b', 'sep_ira', 'simple_ira', 'pension', '457b', 'other'
);

CREATE TYPE "business_entity_type" AS ENUM (
  'llc', 's_corp', 'c_corp', 'partnership', 'sole_proprietorship', 'lp', 'llp', 'other'
);

CREATE TYPE "digital_asset_type" AS ENUM (
  'cryptocurrency', 'nft', 'domain', 'token', 'defi_position', 'other'
);

CREATE TYPE "collectible_type" AS ENUM (
  'art', 'jewelry', 'wine_spirits', 'coins_bullion', 'stamps',
  'vintage_vehicle', 'antiques', 'sports_memorabilia', 'watches', 'other'
);

-- ─── Insurance Policies ──────────────────────────────────────────────────────

CREATE TABLE "estate_insurance_policies" (
  "id"                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_id"                   UUID NOT NULL REFERENCES "estate_assets"("id") ON DELETE CASCADE,
  "company_id"                 UUID NOT NULL REFERENCES "companies"("id"),
  "user_id"                    TEXT NOT NULL,
  "policy_number"              TEXT,
  "insurer"                    TEXT,
  "policy_type"                "insurance_policy_type" NOT NULL DEFAULT 'term',
  "death_benefit_cents"        NUMERIC(20, 0),
  "cash_value_cents"           NUMERIC(20, 0),
  "premium_amount_cents"       NUMERIC(20, 0),
  "premium_frequency"          "premium_frequency",
  "premium_next_due_at"        TIMESTAMPTZ,
  "ilit_trust_name"            TEXT,
  "ilit_trust_entity_id"       TEXT,
  "outstanding_loan_cents"     NUMERIC(20, 0),
  "beneficiaries"              JSONB,
  "document_ids"               TEXT[],
  "is_active"                  BOOLEAN NOT NULL DEFAULT TRUE,
  "notes"                      TEXT,
  "created_at"                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "estate_insurance_asset_idx"        ON "estate_insurance_policies"("asset_id");
CREATE INDEX "estate_insurance_company_user_idx" ON "estate_insurance_policies"("company_id", "user_id");

-- ─── Retirement Accounts ─────────────────────────────────────────────────────

CREATE TABLE "estate_retirement_accounts" (
  "id"                                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_id"                              UUID NOT NULL REFERENCES "estate_assets"("id") ON DELETE CASCADE,
  "company_id"                            UUID NOT NULL REFERENCES "companies"("id"),
  "user_id"                               TEXT NOT NULL,
  "account_type"                          "retirement_account_type" NOT NULL DEFAULT 'traditional_ira',
  "is_roth"                               BOOLEAN NOT NULL DEFAULT FALSE,
  "custodian"                             TEXT,
  "account_number"                        TEXT,
  "annual_contribution_limit_cents"       NUMERIC(20, 0),
  "ytd_contribution_cents"                NUMERIC(20, 0),
  "rmd_required"                          BOOLEAN NOT NULL DEFAULT FALSE,
  "rmd_amount_cents"                      NUMERIC(20, 0),
  "rmd_due_year"                          INTEGER,
  "rmd_withdrawn_this_year_cents"         NUMERIC(20, 0),
  "primary_beneficiaries"                 JSONB,
  "contingent_beneficiaries"              JSONB,
  "document_ids"                          TEXT[],
  "notes"                                 TEXT,
  "created_at"                            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"                            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "estate_retirement_asset_idx"       ON "estate_retirement_accounts"("asset_id");
CREATE INDEX "estate_retirement_company_user_idx" ON "estate_retirement_accounts"("company_id", "user_id");
CREATE INDEX "estate_retirement_rmd_idx"         ON "estate_retirement_accounts"("company_id", "rmd_required", "rmd_due_year");

-- ─── Business Interests ──────────────────────────────────────────────────────

CREATE TABLE "estate_business_interests" (
  "id"                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_id"                     UUID NOT NULL REFERENCES "estate_assets"("id") ON DELETE CASCADE,
  "company_id"                   UUID NOT NULL REFERENCES "companies"("id"),
  "user_id"                      TEXT NOT NULL,
  "business_name"                TEXT NOT NULL,
  "entity_type"                  "business_entity_type" NOT NULL DEFAULT 'llc',
  "ownership_pct"                NUMERIC(7, 4),
  "ein"                          TEXT,
  "state"                        TEXT,
  "last_appraisal_value_cents"   NUMERIC(20, 0),
  "last_appraisal_date"          TIMESTAMPTZ,
  "next_appraisal_due_date"      TIMESTAMPTZ,
  "appraisal_doc_ids"            TEXT[],
  "has_buy_sell_agreement"       BOOLEAN NOT NULL DEFAULT FALSE,
  "buy_sell_agreement_doc_id"    TEXT,
  "buy_sell_triggers"            JSONB,
  "has_key_person_insurance"     BOOLEAN NOT NULL DEFAULT FALSE,
  "key_person_insurance_policy_ids" TEXT[],
  "co_owners"                    JSONB,
  "notes"                        TEXT,
  "created_at"                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"                   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "estate_business_asset_idx"         ON "estate_business_interests"("asset_id");
CREATE INDEX "estate_business_company_user_idx"  ON "estate_business_interests"("company_id", "user_id");
CREATE INDEX "estate_business_appraisal_due_idx" ON "estate_business_interests"("company_id", "next_appraisal_due_date");

-- ─── Digital Assets ──────────────────────────────────────────────────────────

CREATE TABLE "estate_digital_assets" (
  "id"                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_id"             UUID NOT NULL REFERENCES "estate_assets"("id") ON DELETE CASCADE,
  "company_id"           UUID NOT NULL REFERENCES "companies"("id"),
  "user_id"              TEXT NOT NULL,
  "digital_asset_type"   "digital_asset_type" NOT NULL DEFAULT 'cryptocurrency',
  "ticker"               TEXT,
  "blockchain"           TEXT,
  "quantity_held"        NUMERIC(30, 18),
  "wallet_addresses"     JSONB,
  "exchange_accounts"    JSONB,
  "cold_storage_doc_ids" TEXT[],
  "contract_address"     TEXT,
  "token_id"             TEXT,
  "recovery_doc_ids"     TEXT[],
  "notes"                TEXT,
  "created_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "estate_digital_asset_idx"        ON "estate_digital_assets"("asset_id");
CREATE INDEX "estate_digital_company_user_idx" ON "estate_digital_assets"("company_id", "user_id");
CREATE INDEX "estate_digital_ticker_idx"       ON "estate_digital_assets"("company_id", "ticker");

-- ─── Collectibles ────────────────────────────────────────────────────────────

CREATE TABLE "estate_collectibles" (
  "id"                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_id"                   UUID NOT NULL REFERENCES "estate_assets"("id") ON DELETE CASCADE,
  "company_id"                 UUID NOT NULL REFERENCES "companies"("id"),
  "user_id"                    TEXT NOT NULL,
  "collectible_type"           "collectible_type" NOT NULL DEFAULT 'art',
  "artist"                     TEXT,
  "maker"                      TEXT,
  "year_created"               TEXT,
  "medium"                     TEXT,
  "dimensions"                 TEXT,
  "condition"                  TEXT,
  "provenance_doc_ids"         TEXT[],
  "auth_cert_doc_ids"          TEXT[],
  "insurance_rider_doc_ids"    TEXT[],
  "insured_value_cents"        NUMERIC(20, 0),
  "last_appraisal_value_cents" NUMERIC(20, 0),
  "last_appraisal_date"        TIMESTAMPTZ,
  "appraisal_doc_ids"          TEXT[],
  "storage_facility"           TEXT,
  "storage_location"           TEXT,
  "additional_info"            JSONB,
  "notes"                      TEXT,
  "created_at"                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "estate_collectibles_asset_idx"        ON "estate_collectibles"("asset_id");
CREATE INDEX "estate_collectibles_company_user_idx" ON "estate_collectibles"("company_id", "user_id");
CREATE INDEX "estate_collectibles_type_idx"         ON "estate_collectibles"("company_id", "collectible_type");
