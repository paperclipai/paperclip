-- Migration 003 (DOWN): drop pricing_staleness_alerts table, roles
-- SAG-6327 Phase 1 | Parent: SAG-6302
--
-- Drops everything created by 003_pricing_staleness_alerts_up.sql in reverse
-- order. DESTRUCTIVE -- deletes all pricing staleness alert history.
-- Does NOT drop the enrichment_staging schema itself (owned by migration 001).

BEGIN;

-- ─── Revoke all grants before dropping objects ────────────────────────────────

REVOKE ALL ON TABLE enrichment_staging.pricing_staleness_alerts
    FROM pricing_staleness_writer;
REVOKE ALL ON TABLE enrichment_staging.pricing_staleness_alerts
    FROM pricing_staleness_reader;
REVOKE USAGE ON SCHEMA enrichment_staging
    FROM pricing_staleness_writer, pricing_staleness_reader;

-- ─── Drop table (CASCADE drops indexes automatically) ─────────────────────────

DROP TABLE IF EXISTS enrichment_staging.pricing_staleness_alerts CASCADE;

-- ─── Drop roles (skip if other objects still reference them) ──────────────────

DO $$
BEGIN
    DROP ROLE IF EXISTS pricing_staleness_writer;
EXCEPTION
    WHEN dependent_objects_still_exist THEN
        RAISE NOTICE 'Role pricing_staleness_writer has dependents outside this migration; skipping drop.';
END
$$;

DO $$
BEGIN
    DROP ROLE IF EXISTS pricing_staleness_reader;
EXCEPTION
    WHEN dependent_objects_still_exist THEN
        RAISE NOTICE 'Role pricing_staleness_reader has dependents outside this migration; skipping drop.';
END
$$;

COMMIT;
