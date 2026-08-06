-- 0276_needs_retry_status.sql
-- Adds the `needs_retry` textual sentinel for issues whose owning heartbeat
-- run failed without producing partial output (e.g. process_lost, gateway
-- 1012, or any other transient infrastructure error). The existing
-- `issues.status` column already accepts free text so this is purely a
-- documentation/convention change; the index is reshaped so the optimizer
-- can target the new status without a fresh partial index.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'issues_status_needs_retry_check'
  ) THEN
    ALTER TABLE issues
      ADD CONSTRAINT issues_status_needs_retry_check
      CHECK (
        status = ANY (ARRAY['backlog','todo','in_progress','in_review','blocked','done','cancelled','needs_retry'])
      );
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS issues_company_needs_retry_idx
  ON issues (company_id)
  WHERE status = 'needs_retry';
