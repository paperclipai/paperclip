-- Migration 001 (UP): enrichment_staging schema, tables, roles, permissions
-- SAG-2147 | Parent: SAG-2136
--
-- All enrichment pipeline tables live in the 'enrichment_staging' schema,
-- fully isolated from the production catalog (public schema).
-- No FK references to production tables.
-- Promotion is an explicit INSERT...SELECT step, never a trigger.

BEGIN;

-- ─── Schema ──────────────────────────────────────────────────────────────────

CREATE SCHEMA IF NOT EXISTS enrichment_staging;

-- ─── Types ───────────────────────────────────────────────────────────────────

CREATE TYPE enrichment_staging.queue_status AS ENUM (
    'pending',
    'in_flight',
    'done',
    'failed'
);

-- ─── enrichment_queue ────────────────────────────────────────────────────────
-- One row per catalog row queued for AI enrichment.
-- Dispatcher picks 'pending' rows, flips status to 'in_flight', writes the
-- enriched result to enrichment_staging.enrichment_staging, then sets
-- status = 'done' | 'failed'.

CREATE TABLE enrichment_staging.enrichment_queue (
    id            UUID                            NOT NULL DEFAULT gen_random_uuid(),
    source_row_id TEXT                            NOT NULL,
    payload_json  JSONB                           NOT NULL,
    status        enrichment_staging.queue_status NOT NULL DEFAULT 'pending',
    created_at    TIMESTAMPTZ                     NOT NULL DEFAULT NOW(),
    started_at    TIMESTAMPTZ,
    finished_at   TIMESTAMPTZ,

    CONSTRAINT enrichment_queue_pkey PRIMARY KEY (id)
);

CREATE INDEX enrichment_queue_status_created_idx
    ON enrichment_staging.enrichment_queue (status, created_at);

CREATE INDEX enrichment_queue_source_row_id_idx
    ON enrichment_staging.enrichment_queue (source_row_id);

-- ─── enrichment_staging (table) ──────────────────────────────────────────────
-- Holds AI-enriched rows awaiting human review and promotion.
-- source_row_id is a plain text identifier (e.g. SKU); no FK to production.

CREATE TABLE enrichment_staging.enrichment_staging (
    id                   UUID        NOT NULL DEFAULT gen_random_uuid(),
    batch_id             UUID        NOT NULL,
    source_row_id        TEXT        NOT NULL,
    primary_output_json  JSONB,
    fallback_output_json JSONB,
    validator_result     JSONB,
    anomaly_score        NUMERIC(5, 4)  CHECK (anomaly_score BETWEEN 0 AND 1),
    reviewer_verdict     TEXT,
    human_approved_at    TIMESTAMPTZ,
    human_approved_by    TEXT,
    promoted_at          TIMESTAMPTZ,

    CONSTRAINT enrichment_staging_pkey PRIMARY KEY (id)
);

CREATE INDEX enrichment_staging_batch_id_idx
    ON enrichment_staging.enrichment_staging (batch_id);

CREATE INDEX enrichment_staging_source_row_id_idx
    ON enrichment_staging.enrichment_staging (source_row_id);

CREATE INDEX enrichment_staging_reviewer_verdict_idx
    ON enrichment_staging.enrichment_staging (reviewer_verdict)
    WHERE reviewer_verdict IS NOT NULL;

-- ─── enrichment_promotion_log ────────────────────────────────────────────────
-- Append-only audit log of every promotion event.
-- Role permissions enforce INSERT-only (no UPDATE / DELETE granted to any role).
-- approver_agent_id / approver_user_id are text identifiers; no FK to any
-- production table.

CREATE TABLE enrichment_staging.enrichment_promotion_log (
    id                UUID        NOT NULL DEFAULT gen_random_uuid(),
    batch_id          UUID        NOT NULL,
    row_count         INTEGER     NOT NULL CHECK (row_count > 0),
    approver_agent_id TEXT,
    approver_user_id  TEXT,
    promoted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload_json      JSONB       NOT NULL,

    CONSTRAINT enrichment_promotion_log_pkey PRIMARY KEY (id)
);

CREATE INDEX enrichment_promotion_log_batch_id_idx
    ON enrichment_staging.enrichment_promotion_log (batch_id);

CREATE INDEX enrichment_promotion_log_promoted_at_idx
    ON enrichment_staging.enrichment_promotion_log (promoted_at);

-- ─── Roles ───────────────────────────────────────────────────────────────────
-- Create roles only if they don't already exist (idempotent via DO block).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enrichment_dispatcher') THEN
        CREATE ROLE enrichment_dispatcher NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enrichment_reviewer') THEN
        CREATE ROLE enrichment_reviewer NOLOGIN;
    END IF;
END
$$;

-- ─── Permissions: enrichment_staging schema ──────────────────────────────────

GRANT USAGE ON SCHEMA enrichment_staging
    TO enrichment_dispatcher, enrichment_reviewer;

-- enrichment_dispatcher: full read+write on queue + staging;
--   INSERT-only on the promotion log (append-only enforced at role level).
GRANT SELECT, INSERT, UPDATE
    ON TABLE enrichment_staging.enrichment_queue
    TO enrichment_dispatcher;
GRANT SELECT, INSERT, UPDATE
    ON TABLE enrichment_staging.enrichment_staging
    TO enrichment_dispatcher;
GRANT INSERT
    ON TABLE enrichment_staging.enrichment_promotion_log
    TO enrichment_dispatcher;

-- enrichment_reviewer: read-only on queue; full read+write on staging;
--   INSERT-only on the promotion log.
GRANT SELECT
    ON TABLE enrichment_staging.enrichment_queue
    TO enrichment_reviewer;
GRANT SELECT, INSERT, UPDATE
    ON TABLE enrichment_staging.enrichment_staging
    TO enrichment_reviewer;
GRANT INSERT
    ON TABLE enrichment_staging.enrichment_promotion_log
    TO enrichment_reviewer;

-- ─── Negative isolation: no write access to public (production) schema ────────
-- Belt-and-suspenders: revoke CREATE on public so these roles cannot create
-- objects there, and they carry no DML grants on public tables.
REVOKE CREATE ON SCHEMA public FROM enrichment_dispatcher;
REVOKE CREATE ON SCHEMA public FROM enrichment_reviewer;

-- Explicitly revoke any PUBLIC-inherited INSERT/UPDATE/DELETE that may exist
-- (harmless no-op if no such grant was present).
REVOKE INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public
    FROM enrichment_dispatcher;
REVOKE INSERT, UPDATE, DELETE
    ON ALL TABLES IN SCHEMA public
    FROM enrichment_reviewer;

COMMIT;
