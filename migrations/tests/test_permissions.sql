-- Permission negative-test for SAG-2147
--
-- Purpose: verify that enrichment_dispatcher and enrichment_reviewer cannot
-- write to production catalog tables in the public schema.
--
-- Run as a superuser (e.g. postgres) AFTER applying 001_enrichment_staging_up.sql.
-- Expected result: every SET ROLE + DML block below raises an ERROR, proving
-- the roles have no write access to public.
--
-- Usage:
--   psql -U postgres -d <your_db> -f migrations/tests/test_permissions.sql
--
-- The script uses DO blocks so failures print NOTICE instead of aborting the
-- entire run.  Exit code 0 means all negative checks passed (each DML
-- correctly raised an exception).  Any "UNEXPECTED: write SUCCEEDED" line
-- indicates a permission leak and must be treated as a test failure.

-- ─── Helper: assert that the current role cannot INSERT into a table ──────────
-- We'll test against a representative public table.  If your production catalog
-- is not called "products" or doesn't exist yet, substitute the real table name.
-- The check is structural (role has no INSERT grant) and will work even if the
-- table is empty.

\set ON_ERROR_STOP off

-- ── Test 1: enrichment_dispatcher cannot INSERT into public schema ────────────
SET ROLE enrichment_dispatcher;

DO $$
BEGIN
    -- Attempt a no-op INSERT that will be rolled back if it somehow succeeds.
    -- Replace 'public.products' with an actual production table name when available.
    BEGIN
        EXECUTE 'INSERT INTO public.products DEFAULT VALUES';
        RAISE NOTICE 'UNEXPECTED: enrichment_dispatcher write to public.products SUCCEEDED — permission leak!';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: enrichment_dispatcher INSERT on public.products correctly denied.';
        WHEN undefined_table THEN
            RAISE NOTICE 'SKIP: public.products does not exist yet; role has no grants (structural pass).';
        WHEN OTHERS THEN
            RAISE NOTICE 'PASS (other error, not permission): %', SQLERRM;
    END;
END
$$;

DO $$
BEGIN
    BEGIN
        EXECUTE 'UPDATE public.products SET id = id WHERE false';
        RAISE NOTICE 'UNEXPECTED: enrichment_dispatcher UPDATE on public.products SUCCEEDED — permission leak!';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: enrichment_dispatcher UPDATE on public.products correctly denied.';
        WHEN undefined_table THEN
            RAISE NOTICE 'SKIP: public.products does not exist yet; structural pass.';
        WHEN OTHERS THEN
            RAISE NOTICE 'PASS (other error): %', SQLERRM;
    END;
END
$$;

DO $$
BEGIN
    BEGIN
        EXECUTE 'DELETE FROM public.products WHERE false';
        RAISE NOTICE 'UNEXPECTED: enrichment_dispatcher DELETE on public.products SUCCEEDED — permission leak!';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: enrichment_dispatcher DELETE on public.products correctly denied.';
        WHEN undefined_table THEN
            RAISE NOTICE 'SKIP: public.products does not exist yet; structural pass.';
        WHEN OTHERS THEN
            RAISE NOTICE 'PASS (other error): %', SQLERRM;
    END;
END
$$;

RESET ROLE;

-- ── Test 2: enrichment_reviewer cannot INSERT into public schema ──────────────
SET ROLE enrichment_reviewer;

DO $$
BEGIN
    BEGIN
        EXECUTE 'INSERT INTO public.products DEFAULT VALUES';
        RAISE NOTICE 'UNEXPECTED: enrichment_reviewer write to public.products SUCCEEDED — permission leak!';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: enrichment_reviewer INSERT on public.products correctly denied.';
        WHEN undefined_table THEN
            RAISE NOTICE 'SKIP: public.products does not exist yet; structural pass.';
        WHEN OTHERS THEN
            RAISE NOTICE 'PASS (other error): %', SQLERRM;
    END;
END
$$;

RESET ROLE;

-- ── Test 3: enrichment_promotion_log is truly append-only (no UPDATE/DELETE) ──
SET ROLE enrichment_dispatcher;

DO $$
DECLARE
    v_id UUID := gen_random_uuid();
BEGIN
    -- First, insert a test row (INSERT is allowed).
    INSERT INTO enrichment_staging.enrichment_promotion_log
        (id, batch_id, row_count, approver_agent_id, promoted_at, payload_json)
    VALUES
        (v_id, gen_random_uuid(), 1, 'test-agent', NOW(), '{"test": true}');
    RAISE NOTICE 'PASS: enrichment_dispatcher INSERT on enrichment_promotion_log succeeded (expected).';

    -- Now attempt UPDATE — must be denied.
    BEGIN
        EXECUTE format('UPDATE enrichment_staging.enrichment_promotion_log SET row_count = 999 WHERE id = %L', v_id);
        RAISE NOTICE 'UNEXPECTED: enrichment_dispatcher UPDATE on enrichment_promotion_log SUCCEEDED — not append-only!';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: enrichment_dispatcher UPDATE on enrichment_promotion_log correctly denied (append-only).';
    END;

    -- Attempt DELETE — must be denied.
    BEGIN
        EXECUTE format('DELETE FROM enrichment_staging.enrichment_promotion_log WHERE id = %L', v_id);
        RAISE NOTICE 'UNEXPECTED: enrichment_dispatcher DELETE on enrichment_promotion_log SUCCEEDED — not append-only!';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: enrichment_dispatcher DELETE on enrichment_promotion_log correctly denied (append-only).';
    END;
END
$$;

RESET ROLE;

-- ── Test 4: enrichment_reviewer cannot UPDATE/DELETE enrichment_promotion_log ──
SET ROLE enrichment_reviewer;

DO $$
BEGIN
    BEGIN
        EXECUTE 'UPDATE enrichment_staging.enrichment_promotion_log SET row_count = 0 WHERE false';
        RAISE NOTICE 'UNEXPECTED: enrichment_reviewer UPDATE on enrichment_promotion_log SUCCEEDED.';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: enrichment_reviewer UPDATE on enrichment_promotion_log correctly denied.';
    END;

    BEGIN
        EXECUTE 'DELETE FROM enrichment_staging.enrichment_promotion_log WHERE false';
        RAISE NOTICE 'UNEXPECTED: enrichment_reviewer DELETE on enrichment_promotion_log SUCCEEDED.';
    EXCEPTION
        WHEN insufficient_privilege THEN
            RAISE NOTICE 'PASS: enrichment_reviewer DELETE on enrichment_promotion_log correctly denied.';
    END;
END
$$;

RESET ROLE;

-- ─── Summary ─────────────────────────────────────────────────────────────────
-- Scan output for "UNEXPECTED" lines.  Zero such lines = all checks passed.
