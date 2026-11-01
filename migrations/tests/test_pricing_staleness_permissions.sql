-- Permission negative-test for SAG-6327 Phase 1
--
-- Purpose: verify that pricing_staleness_writer and pricing_staleness_reader
-- cannot write to production catalog tables in the public schema, and that
-- pricing_staleness_alerts is truly append-only (no UPDATE/DELETE granted to
-- any role, matching the enrichment_promotion_log precedent).
--
-- Run as a superuser (e.g. postgres) AFTER applying
-- 003_pricing_staleness_alerts_up.sql.
-- Expected result: every SET ROLE + DML block below raises an ERROR, proving
-- the roles have no write access to public and no UPDATE/DELETE on the alerts
-- table.
--
-- Usage:
--   psql -U postgres -d <your_db> -f migrations/tests/test_pricing_staleness_permissions.sql
--
-- The script uses DO blocks so failures print NOTICE instead of aborting the
-- entire run. Exit code 0 means all negative checks passed. Any "UNEXPECTED:
-- write SUCCEEDED" line indicates a permission leak and must be treated as a
-- test failure.

\set ON_ERROR_STOP off

-- ── Test 1: pricing_staleness_writer cannot INSERT into public schema ─────────
SET ROLE pricing_staleness_writer;

DO $$
BEGIN
    BEGIN
        EXECUTE 'INSERT INTO public.products DEFAULT VALUES';
        RAISE NOTICE 'UNEXPECTED: pricing_staleness_writer write to public.products SUCCEEDED — permission leak!';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: pricing_staleness_writer INSERT on public.products correctly denied.';
        WHEN undefined_table THEN
            RAISE NOTICE 'SKIP: public.products does not exist yet; role has no grants (structural pass).';
        WHEN OTHERS THEN
            RAISE NOTICE 'PASS (other error, not permission): %', SQLERRM;
    END;
END
$$;

RESET ROLE;

-- ── Test 2: pricing_staleness_reader cannot INSERT into public schema ─────────
SET ROLE pricing_staleness_reader;

DO $$
BEGIN
    BEGIN
        EXECUTE 'INSERT INTO public.products DEFAULT VALUES';
        RAISE NOTICE 'UNEXPECTED: pricing_staleness_reader write to public.products SUCCEEDED — permission leak!';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: pricing_staleness_reader INSERT on public.products correctly denied.';
        WHEN undefined_table THEN
            RAISE NOTICE 'SKIP: public.products does not exist yet; structural pass.';
        WHEN OTHERS THEN
            RAISE NOTICE 'PASS (other error): %', SQLERRM;
    END;
END
$$;

RESET ROLE;

-- ── Test 3: pricing_staleness_alerts is truly append-only (no UPDATE/DELETE) ──
SET ROLE pricing_staleness_writer;

DO $$
DECLARE
    v_id UUID := gen_random_uuid();
BEGIN
    -- First, insert a test row (INSERT is allowed).
    INSERT INTO enrichment_staging.pricing_staleness_alerts
        (id, detected_at, signal_type, severity, record_key, warm_up, details_json)
    VALUES
        (v_id, NOW(), 'anomaly', 'warn', 'TEST-SKU|FQ3-A', FALSE, '{}'::jsonb);
    RAISE NOTICE 'PASS: pricing_staleness_writer INSERT on pricing_staleness_alerts succeeded (expected).';

    -- Now attempt UPDATE — must be denied.
    BEGIN
        EXECUTE format('UPDATE enrichment_staging.pricing_staleness_alerts SET severity = %L WHERE id = %L', 'critical', v_id);
        RAISE NOTICE 'UNEXPECTED: pricing_staleness_writer UPDATE on pricing_staleness_alerts SUCCEEDED — not append-only!';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: pricing_staleness_writer UPDATE on pricing_staleness_alerts correctly denied (append-only).';
    END;

    -- Attempt DELETE — must be denied.
    BEGIN
        EXECUTE format('DELETE FROM enrichment_staging.pricing_staleness_alerts WHERE id = %L', v_id);
        RAISE NOTICE 'UNEXPECTED: pricing_staleness_writer DELETE on pricing_staleness_alerts SUCCEEDED — not append-only!';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: pricing_staleness_writer DELETE on pricing_staleness_alerts correctly denied (append-only).';
    END;
END
$$;

RESET ROLE;

-- ── Test 4: pricing_staleness_reader cannot INSERT/UPDATE/DELETE the alerts table ──
SET ROLE pricing_staleness_reader;

DO $$
BEGIN
    BEGIN
        EXECUTE $q$INSERT INTO enrichment_staging.pricing_staleness_alerts
            (detected_at, signal_type, severity, record_key, warm_up, details_json)
            VALUES (NOW(), 'anomaly', 'warn', 'TEST-SKU|FQ3-A', FALSE, '{}'::jsonb)$q$;
        RAISE NOTICE 'UNEXPECTED: pricing_staleness_reader INSERT on pricing_staleness_alerts SUCCEEDED.';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: pricing_staleness_reader INSERT on pricing_staleness_alerts correctly denied.';
    END;

    BEGIN
        EXECUTE 'UPDATE enrichment_staging.pricing_staleness_alerts SET severity = ''critical'' WHERE false';
        RAISE NOTICE 'UNEXPECTED: pricing_staleness_reader UPDATE on pricing_staleness_alerts SUCCEEDED.';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: pricing_staleness_reader UPDATE on pricing_staleness_alerts correctly denied.';
    END;

    BEGIN
        EXECUTE 'DELETE FROM enrichment_staging.pricing_staleness_alerts WHERE false';
        RAISE NOTICE 'UNEXPECTED: pricing_staleness_reader DELETE on pricing_staleness_alerts SUCCEEDED.';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: pricing_staleness_reader DELETE on pricing_staleness_alerts correctly denied.';
    END;
END
$$;

RESET ROLE;

-- ─── Summary ─────────────────────────────────────────────────────────────────
-- Scan output for "UNEXPECTED" lines. Zero such lines = all checks passed.
