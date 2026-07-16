ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "instance_nonce" uuid;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "seed_epoch" uuid;
ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "instance_nonce" uuid;
ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "seed_epoch" uuid;

CREATE OR REPLACE FUNCTION stamp_run_execution_provenance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  experimental jsonb;
BEGIN
  SELECT settings.experimental INTO experimental
  FROM instance_settings settings
  WHERE settings.singleton_key = 'default'
  LIMIT 1;

  NEW.instance_nonce := COALESCE(
    NEW.instance_nonce,
    NULLIF(experimental ->> 'worktreeRunExecutionInstanceNonce', '')::uuid
  );
  NEW.seed_epoch := COALESCE(
    NEW.seed_epoch,
    NULLIF(experimental ->> 'worktreeRunExecutionSeedEpoch', '')::uuid
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS heartbeat_runs_stamp_execution_provenance ON heartbeat_runs;
CREATE TRIGGER heartbeat_runs_stamp_execution_provenance
BEFORE INSERT ON heartbeat_runs
FOR EACH ROW EXECUTE FUNCTION stamp_run_execution_provenance();

DROP TRIGGER IF EXISTS agent_wakeup_requests_stamp_execution_provenance ON agent_wakeup_requests;
CREATE TRIGGER agent_wakeup_requests_stamp_execution_provenance
BEFORE INSERT ON agent_wakeup_requests
FOR EACH ROW EXECUTE FUNCTION stamp_run_execution_provenance();
