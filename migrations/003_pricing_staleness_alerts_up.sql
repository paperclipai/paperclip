-- Migration 003 (UP): pricing_staleness_alerts table, roles, permissions
-- SAG-6327 Phase 1 | Parent: SAG-6302
-- Reconciled to the tested runner contract in SAG-6353.
--
-- Append-only detection-alert log for the pricing staleness runner. Lives in
-- the existing 'enrichment_staging' schema, fully isolated from the
-- production catalog (public schema) and decoupled from Pricing's own
-- feed-spec grain (SAG-6341) -- record_key is a plain text identifier, not a
-- FK. Role permissions enforce INSERT/SELECT-only (no UPDATE / DELETE
-- granted to any role) -- append-only, matching the enrichment_promotion_log
-- precedent from migration 001.

BEGIN;

-- ─── pricing_staleness_alerts ──────────────────────────────────────────────
-- One row per detection event, written by the nightly detection runner
-- (SAG-6327 Phase 3+4, SAG-6344). Column grain matches the runner's own
-- `StalenessAlert` shape 1:1 (infra/runtime-eval/pricing_staleness_alerts.py)
-- so no reconciliation/mapping layer is needed between the two: signal_type
-- and severity CHECK values are exactly the strings the runner emits.
-- warm_up is stamped by the runner (true for the 30-day warm-up window,
-- SAG-6327 Phase 4); details_json carries signal-specific evidence
-- (pct_delta, versions, due/committed timestamps, etc.).

CREATE TABLE enrichment_staging.pricing_staleness_alerts (
    id           UUID        NOT NULL DEFAULT gen_random_uuid(),
    signal_type  TEXT        NOT NULL
        CHECK (signal_type IN ('anomaly','version_hash_drift','sla_breach','bulk_escalation')),
    severity     TEXT        NOT NULL
        CHECK (severity IN ('warn','critical')),
    record_key   TEXT        NOT NULL,
    detected_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    warm_up      BOOLEAN     NOT NULL DEFAULT FALSE,
    details_json JSONB       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT pricing_staleness_alerts_pkey PRIMARY KEY (id)
);

CREATE INDEX pricing_staleness_alerts_detected_at_idx
    ON enrichment_staging.pricing_staleness_alerts (detected_at);

-- Serves the Phase 5 freeze-arming check ("≥1 clean baseline median per
-- record") now that sku/bucket_code are folded into record_key.
CREATE INDEX pricing_staleness_alerts_record_key_idx
    ON enrichment_staging.pricing_staleness_alerts (record_key);

-- ─── Roles ───────────────────────────────────────────────────────────────────
-- Create roles only if they don't already exist (idempotent via DO block).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pricing_staleness_writer') THEN
        CREATE ROLE pricing_staleness_writer NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pricing_staleness_reader') THEN
        CREATE ROLE pricing_staleness_reader NOLOGIN;
    END IF;
END
$$;

-- ─── Permissions: enrichment_staging schema ──────────────────────────────────

GRANT USAGE ON SCHEMA enrichment_staging
    TO pricing_staleness_writer, pricing_staleness_reader;

-- pricing_staleness_writer: the nightly detection runner. INSERT + SELECT
--   only (append-only; no UPDATE/DELETE granted to any role).
GRANT SELECT, INSERT
    ON TABLE enrichment_staging.pricing_staleness_alerts
    TO pricing_staleness_writer;

-- pricing_staleness_reader: digest/QA/freeze-arming consumers. SELECT-only.
GRANT SELECT
    ON TABLE enrichment_staging.pricing_staleness_alerts
    TO pricing_staleness_reader;

-- ─── Negative isolation: no write access to public (production) schema ────────
-- Belt-and-suspenders: revoke CREATE on public so these roles cannot create
-- objects there, and they carry no DML grants on public tables.
REVOKE CREATE ON SCHEMA public FROM pricing_staleness_writer;
REVOKE CREATE ON SCHEMA public FROM pricing_staleness_reader;

REVOKE INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public
    FROM pricing_staleness_writer;
REVOKE INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public
    FROM pricing_staleness_reader;

COMMIT;
