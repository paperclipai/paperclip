-- Migration 001 (DOWN): drop enrichment_staging schema, tables, types, roles
-- SAG-2147 | Parent: SAG-2136
--
-- Drops everything created by 001_enrichment_staging_up.sql in reverse order.
-- DESTRUCTIVE — deletes all enrichment queue, staging, and audit data.

BEGIN;

-- ─── Revoke all grants before dropping objects ────────────────────────────────

REVOKE ALL ON ALL TABLES IN SCHEMA enrichment_staging
    FROM enrichment_dispatcher;
REVOKE ALL ON ALL TABLES IN SCHEMA enrichment_staging
    FROM enrichment_reviewer;
REVOKE USAGE ON SCHEMA enrichment_staging
    FROM enrichment_dispatcher, enrichment_reviewer;

-- ─── Drop tables (CASCADE drops indexes automatically) ────────────────────────

DROP TABLE IF EXISTS enrichment_staging.enrichment_promotion_log CASCADE;
DROP TABLE IF EXISTS enrichment_staging.enrichment_staging CASCADE;
DROP TABLE IF EXISTS enrichment_staging.enrichment_queue CASCADE;

-- ─── Drop type ───────────────────────────────────────────────────────────────

DROP TYPE IF EXISTS enrichment_staging.queue_status;

-- ─── Drop schema ─────────────────────────────────────────────────────────────

DROP SCHEMA IF EXISTS enrichment_staging;

-- ─── Drop roles (skip if other objects still reference them) ──────────────────

DO $$
BEGIN
    DROP ROLE IF EXISTS enrichment_dispatcher;
EXCEPTION
    WHEN dependent_objects_still_exist THEN
        RAISE NOTICE 'Role enrichment_dispatcher has dependents outside this migration; skipping drop.';
END
$$;

DO $$
BEGIN
    DROP ROLE IF EXISTS enrichment_reviewer;
EXCEPTION
    WHEN dependent_objects_still_exist THEN
        RAISE NOTICE 'Role enrichment_reviewer has dependents outside this migration; skipping drop.';
END
$$;

COMMIT;
