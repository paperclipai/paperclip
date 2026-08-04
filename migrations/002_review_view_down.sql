-- Migration 002 (DOWN): drop enrichment_staging_review_view + enrichment_ui_reader role
-- SAG-2149 | Parent: SAG-2136

BEGIN;

DROP VIEW IF EXISTS enrichment_staging.enrichment_staging_review_view;

-- Revoke before drop to satisfy Postgres dependency checks
REVOKE ALL ON SCHEMA enrichment_staging FROM enrichment_ui_reader;
REVOKE ALL ON ALL TABLES IN SCHEMA enrichment_staging FROM enrichment_ui_reader;

DROP ROLE IF EXISTS enrichment_ui_reader;

COMMIT;
