CREATE OR REPLACE FUNCTION paperclip_lock_heartbeat_run_agent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM 1
  FROM "agents"
  WHERE "id" = NEW."agent_id"
    AND "company_id" = NEW."company_id"
  FOR SHARE;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS heartbeat_runs_lock_agent ON "heartbeat_runs";
CREATE TRIGGER heartbeat_runs_lock_agent
  BEFORE INSERT OR UPDATE OF "agent_id", "company_id", "status"
  ON "heartbeat_runs"
  FOR EACH ROW
  EXECUTE FUNCTION paperclip_lock_heartbeat_run_agent();
