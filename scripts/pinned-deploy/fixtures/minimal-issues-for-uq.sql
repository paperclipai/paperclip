-- Minimal schema sufficient to exercise issues_open_fallback_monitor_execution_uq.
-- Used only on disposable databases created by pinned-deploy-snapshot-smoke.sh.

CREATE TABLE IF NOT EXISTS issues (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  title text NOT NULL,
  status text NOT NULL,
  origin_kind text,
  hidden_at timestamptz
);
