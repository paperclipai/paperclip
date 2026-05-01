-- Phase 2 Priority 3: Compliance & Automation
-- IUN-318 — valuation reminders, document expiry alerts, annual review workflow,
--            multi-state property tax calendar

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "valuation_reminder_frequency" AS ENUM ('monthly', 'quarterly', 'semi_annual', 'annual', 'custom');

CREATE TYPE "document_alert_type" AS ENUM (
  'insurance_renewal',
  'lease_expiration',
  'appraisal_due',
  'license_expiration',
  'tax_filing_deadline',
  'other'
);

CREATE TYPE "document_alert_status" AS ENUM ('active', 'dismissed', 'expired');

CREATE TYPE "estate_review_status" AS ENUM ('pending', 'in_progress', 'complete');

CREATE TYPE "property_tax_status" AS ENUM ('upcoming', 'paid', 'overdue', 'exempt');

-- ─── Valuation Reminders ─────────────────────────────────────────────────────

CREATE TABLE "estate_valuation_reminders" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_id"          UUID NOT NULL REFERENCES "estate_assets"("id") ON DELETE CASCADE,
  "company_id"        UUID NOT NULL REFERENCES "companies"("id"),
  "user_id"           TEXT NOT NULL,
  "frequency"         "valuation_reminder_frequency" NOT NULL DEFAULT 'annual',
  "frequency_days"    INTEGER NOT NULL DEFAULT 365,
  "last_reminded_at"  TIMESTAMPTZ,
  "next_due_at"       TIMESTAMPTZ NOT NULL,
  "is_active"         BOOLEAN NOT NULL DEFAULT TRUE,
  "notes"             TEXT,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "estate_val_reminders_asset_idx"       ON "estate_valuation_reminders"("asset_id");
CREATE INDEX "estate_val_reminders_company_user_idx" ON "estate_valuation_reminders"("company_id", "user_id");
CREATE INDEX "estate_val_reminders_due_idx"         ON "estate_valuation_reminders"("next_due_at") WHERE "is_active" = TRUE;

-- ─── Document Expiry Alerts ───────────────────────────────────────────────────

CREATE TABLE "estate_document_alerts" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"          UUID NOT NULL REFERENCES "companies"("id"),
  "user_id"             TEXT NOT NULL,
  "asset_id"            UUID REFERENCES "estate_assets"("id") ON DELETE SET NULL,
  "document_name"       TEXT NOT NULL,
  "alert_type"          "document_alert_type" NOT NULL DEFAULT 'other',
  "expires_at"          TIMESTAMPTZ NOT NULL,
  "alert_days_before"   INTEGER[] NOT NULL DEFAULT '{30,60,90}',
  "last_alerted_at"     TIMESTAMPTZ,
  "status"              "document_alert_status" NOT NULL DEFAULT 'active',
  "notes"               TEXT,
  "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "estate_doc_alerts_company_user_idx" ON "estate_document_alerts"("company_id", "user_id");
CREATE INDEX "estate_doc_alerts_asset_idx"        ON "estate_document_alerts"("asset_id");
CREATE INDEX "estate_doc_alerts_expires_idx"      ON "estate_document_alerts"("expires_at") WHERE "status" = 'active';

-- ─── Annual Estate Reviews ────────────────────────────────────────────────────

CREATE TABLE "estate_reviews" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"   UUID NOT NULL REFERENCES "companies"("id"),
  "user_id"      TEXT NOT NULL,
  "review_year"  INTEGER NOT NULL,
  "status"       "estate_review_status" NOT NULL DEFAULT 'pending',
  "checklist"    JSONB NOT NULL DEFAULT '[]',
  "notes"        TEXT,
  "reviewed_at"  TIMESTAMPTZ,
  "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("company_id", "user_id", "review_year")
);

CREATE INDEX "estate_reviews_company_user_idx" ON "estate_reviews"("company_id", "user_id");
CREATE INDEX "estate_reviews_year_idx"         ON "estate_reviews"("company_id", "review_year");

-- ─── Property Tax Calendar ────────────────────────────────────────────────────

CREATE TABLE "estate_property_tax_bills" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_id"           UUID NOT NULL REFERENCES "estate_assets"("id") ON DELETE CASCADE,
  "company_id"         UUID NOT NULL REFERENCES "companies"("id"),
  "user_id"            TEXT NOT NULL,
  "state"              TEXT NOT NULL,
  "county"             TEXT,
  "tax_year"           INTEGER NOT NULL,
  "installment"        INTEGER NOT NULL DEFAULT 1,
  "due_date"           TIMESTAMPTZ NOT NULL,
  "amount_cents"       NUMERIC(20, 0),
  "status"             "property_tax_status" NOT NULL DEFAULT 'upcoming',
  "paid_at"            TIMESTAMPTZ,
  "paid_amount_cents"  NUMERIC(20, 0),
  "notes"              TEXT,
  "created_at"         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "estate_prop_tax_asset_idx"        ON "estate_property_tax_bills"("asset_id");
CREATE INDEX "estate_prop_tax_company_user_idx" ON "estate_property_tax_bills"("company_id", "user_id");
CREATE INDEX "estate_prop_tax_due_idx"          ON "estate_property_tax_bills"("due_date") WHERE "status" IN ('upcoming', 'overdue');
CREATE INDEX "estate_prop_tax_state_year_idx"   ON "estate_property_tax_bills"("company_id", "state", "tax_year");
