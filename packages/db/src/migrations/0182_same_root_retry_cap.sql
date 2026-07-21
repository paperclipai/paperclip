ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "retry_root_run_id" uuid REFERENCES heartbeat_runs(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "retry_epoch" integer NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS heartbeat_runs_retry_root_epoch_idx
  ON heartbeat_runs (retry_root_run_id, retry_epoch)
  WHERE retry_root_run_id IS NOT NULL;
