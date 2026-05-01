-- Phase 2 Priority 2: Advanced Financial Features
-- IUN-318 — tax lots, net worth history

-- ─── Enums ───────────────────────────────────────────────────────────────────

CREATE TYPE "tax_lot_status" AS ENUM ('open', 'closed', 'transferred');

-- ─── Tax Lots ────────────────────────────────────────────────────────────────

CREATE TABLE "estate_tax_lots" (
  "id"                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "asset_id"                       UUID NOT NULL REFERENCES "estate_assets"("id") ON DELETE CASCADE,
  "company_id"                     UUID NOT NULL REFERENCES "companies"("id"),
  "user_id"                        TEXT NOT NULL,
  "ticker"                         TEXT,
  "cusip"                          TEXT,
  "security_name"                  TEXT,
  "shares"                         NUMERIC(20, 8) NOT NULL,
  "cost_basis_per_share_cents"     NUMERIC(20, 4) NOT NULL,
  "total_cost_basis_cents"         NUMERIC(20, 0) NOT NULL,
  "acquired_at"                    TIMESTAMPTZ NOT NULL,
  "current_price_per_share_cents"  NUMERIC(20, 4),
  "current_value_cents"            NUMERIC(20, 0),
  "status"                         "tax_lot_status" NOT NULL DEFAULT 'open',
  "sold_at"                        TIMESTAMPTZ,
  "sale_per_share_cents"           NUMERIC(20, 4),
  "is_long_term"                   BOOLEAN NOT NULL DEFAULT FALSE,
  "is_wash_sale"                   BOOLEAN NOT NULL DEFAULT FALSE,
  "wash_sale_disallowed_cents"     NUMERIC(20, 0),
  "notes"                          TEXT,
  "created_at"                     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at"                     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "estate_tax_lots_asset_idx"        ON "estate_tax_lots"("asset_id");
CREATE INDEX "estate_tax_lots_company_user_idx" ON "estate_tax_lots"("company_id", "user_id");
CREATE INDEX "estate_tax_lots_ticker_idx"       ON "estate_tax_lots"("company_id", "ticker");
CREATE INDEX "estate_tax_lots_status_idx"       ON "estate_tax_lots"("company_id", "status");

-- ─── Net Worth Snapshots ─────────────────────────────────────────────────────

CREATE TABLE "estate_net_worth_snapshots" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id"            UUID NOT NULL REFERENCES "companies"("id"),
  "user_id"               TEXT NOT NULL,
  "snapshot_date"         TIMESTAMPTZ NOT NULL,
  "net_worth_cents"       NUMERIC(20, 0) NOT NULL,
  "assets_total_cents"    NUMERIC(20, 0) NOT NULL,
  "accounts_total_cents"  NUMERIC(20, 0) NOT NULL,
  "breakdown"             JSONB,
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "estate_nw_snapshots_company_user_date_idx"
  ON "estate_net_worth_snapshots"("company_id", "user_id", "snapshot_date");
