-- ATTOM property enrichment columns on estate_assets
ALTER TABLE estate_assets
  ADD COLUMN IF NOT EXISTS attom_property_id      text,
  ADD COLUMN IF NOT EXISTS assessed_value_cents   numeric(20, 0),
  ADD COLUMN IF NOT EXISTS valuation_source       text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS attom_enriched_at      timestamptz,
  ADD COLUMN IF NOT EXISTS attom_square_feet      integer,
  ADD COLUMN IF NOT EXISTS attom_lot_size_sq_ft   integer,
  ADD COLUMN IF NOT EXISTS attom_year_built       integer;

CREATE INDEX IF NOT EXISTS estate_assets_attom_property_idx
  ON estate_assets (attom_property_id);
