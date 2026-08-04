-- Migration 002 (UP): enrichment_staging_review_view + enrichment_ui_reader role
-- SAG-2149 | Parent: SAG-2136
--
-- Creates a read-only view that joins enrichment_staging with the latest
-- enrichment_queue payload for each source_row_id.  The enrichment_ui_reader
-- role may SELECT the view and UPDATE only the three human-review columns on
-- the base table.  It has no INSERT, DELETE, or production-schema access.

BEGIN;

-- ─── View ────────────────────────────────────────────────────────────────────
-- LATERAL join picks the most-recent queue entry for each source_row_id so
-- the reviewer sees the actual input payload that produced the enrichment.
-- is_flagged mirrors the anomaly_rules threshold (≥0.5) plus validator failure.

CREATE OR REPLACE VIEW enrichment_staging.enrichment_staging_review_view AS
SELECT
    es.id,
    es.batch_id,
    es.source_row_id,
    eq_latest.payload_json          AS source_payload_json,
    es.primary_output_json,
    es.fallback_output_json,
    es.validator_result,
    es.anomaly_score,
    es.reviewer_verdict,
    es.human_approved_at,
    es.human_approved_by,
    es.promoted_at,
    CASE
        WHEN es.anomaly_score IS NOT NULL AND es.anomaly_score >= 0.5             THEN true
        WHEN es.validator_result IS NOT NULL
             AND (es.validator_result->>'valid')::boolean IS NOT DISTINCT FROM false THEN true
        ELSE false
    END AS is_flagged
FROM enrichment_staging.enrichment_staging es
LEFT JOIN LATERAL (
    SELECT payload_json
    FROM   enrichment_staging.enrichment_queue eq
    WHERE  eq.source_row_id = es.source_row_id
    ORDER  BY eq.created_at DESC
    LIMIT  1
) eq_latest ON true;

-- ─── Role ─────────────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enrichment_ui_reader') THEN
        CREATE ROLE enrichment_ui_reader NOLOGIN;
    END IF;
END
$$;

-- Schema usage
GRANT USAGE ON SCHEMA enrichment_staging TO enrichment_ui_reader;

-- SELECT on base tables (required because the view is SECURITY INVOKER by default)
GRANT SELECT ON TABLE enrichment_staging.enrichment_queue     TO enrichment_ui_reader;
GRANT SELECT ON TABLE enrichment_staging.enrichment_staging   TO enrichment_ui_reader;
GRANT SELECT ON TABLE enrichment_staging.enrichment_staging_review_view TO enrichment_ui_reader;

-- Column-level UPDATE: only the three human-review fields; no INSERT or DELETE
GRANT UPDATE (human_approved_at, human_approved_by, reviewer_verdict)
    ON TABLE enrichment_staging.enrichment_staging
    TO enrichment_ui_reader;

-- Belt-and-suspenders: no production-schema access
REVOKE CREATE ON SCHEMA public FROM enrichment_ui_reader;
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM enrichment_ui_reader;

COMMIT;
