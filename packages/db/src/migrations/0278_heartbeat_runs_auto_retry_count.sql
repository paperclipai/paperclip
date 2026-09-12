-- 0277_heartbeat_runs_auto_retry_count.sql
-- Adds `auto_retry_count` to heartbeat_runs for the generic auto-retry path
-- described in the kanban-retry rollout (auto-retry when stdout_excerpt is
-- empty and the run failed with a transient infrastructure error).
--
-- The pre-existing `process_loss_retry_count` column is preserved for
-- backwards-compatibility and is bumped in lock-step when a process_loss
-- auto-retry fires; `auto_retry_count` covers the broader class of "retry
-- triggered automatically because zero work started" reasons.

ALTER TABLE heartbeat_runs
  ADD COLUMN IF NOT EXISTS auto_retry_count integer NOT NULL DEFAULT 0;

ALTER TABLE heartbeat_runs
  ADD COLUMN IF NOT EXISTS auto_retry_reason text;

ALTER TABLE heartbeat_runs
  ADD COLUMN IF NOT EXISTS next_auto_retry_at timestamptz;

CREATE INDEX IF NOT EXISTS heartbeat_runs_company_auto_retry_idx
  ON heartbeat_runs (company_id, status, created_at)
  WHERE auto_retry_count > 0;
