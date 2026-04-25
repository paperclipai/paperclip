-- Phase 0.7: Quiescent state
-- Idle agents stop burning tokens. Wake on events only.

CREATE TABLE IF NOT EXISTS "agent_idle_state" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'active',
  "empty_heartbeat_streak" integer NOT NULL DEFAULT 0,
  "last_meaningful_action_at" timestamptz,
  "quiesced_at" timestamptz,
  "next_watchdog_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_idle_state_agent_id_idx" ON "agent_idle_state" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_idle_state_state_idx" ON "agent_idle_state" USING btree ("state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_idle_state_next_watchdog_idx" ON "agent_idle_state" USING btree ("next_watchdog_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_idle_state_agent_id_uq" ON "agent_idle_state" ("agent_id");

-- Helper: get or create idle state for an agent
CREATE OR REPLACE FUNCTION get_or_create_agent_idle_state(p_agent_id uuid)
RETURNS agent_idle_state AS $$
DECLARE
  v_state agent_idle_state%ROWTYPE;
BEGIN
  SELECT * INTO v_state FROM agent_idle_state WHERE agent_id = p_agent_id;
  IF v_state.id IS NULL THEN
    INSERT INTO agent_idle_state (agent_id, state) VALUES (p_agent_id, 'active')
    RETURNING * INTO v_state;
  END IF;
  RETURN v_state;
END;
$$ LANGUAGE plpgsql;

-- Helper: record a meaningful action (resets empty heartbeat streak)
CREATE OR REPLACE FUNCTION record_meaningful_action(p_agent_id uuid)
RETURNS void AS $$
  UPDATE agent_idle_state
  SET
    empty_heartbeat_streak = 0,
    last_meaningful_action_at = NOW(),
    state = 'active',
    quiesced_at = NULL,
    updated_at = NOW()
  WHERE agent_id = p_agent_id;
$$ LANGUAGE sql;

-- Helper: increment empty heartbeat streak; quiesce after 3 consecutive empty
CREATE OR REPLACE FUNCTION record_empty_heartbeat(p_agent_id uuid)
RETURNS agent_idle_state AS $$
DECLARE
  v_state agent_idle_state%ROWTYPE;
  v_new_streak integer;
BEGIN
  SELECT * INTO v_state FROM agent_idle_state WHERE agent_id = p_agent_id;

  IF v_state.id IS NULL THEN
    INSERT INTO agent_idle_state (agent_id, state, empty_heartbeat_streak, last_meaningful_action_at)
    VALUES (p_agent_id, 'active', 1, NOW())
    RETURNING * INTO v_state;
    RETURN v_state;
  END IF;

  IF v_state.state = 'quiescent' THEN
    RETURN v_state;
  END IF;

  v_new_streak := v_state.empty_heartbeat_streak + 1;

  IF v_new_streak >= 3 THEN
    UPDATE agent_idle_state
    SET
      state = 'quiescent',
      empty_heartbeat_streak = v_new_streak,
      quiesced_at = NOW(),
      next_watchdog_at = NOW() + INTERVAL '60 minutes',
      updated_at = NOW()
    WHERE agent_id = p_agent_id
    RETURNING * INTO v_state;
  ELSE
    UPDATE agent_idle_state
    SET
      empty_heartbeat_streak = v_new_streak,
      updated_at = NOW()
    WHERE agent_id = p_agent_id
    RETURNING * INTO v_state;
  END IF;

  RETURN v_state;
END;
$$ LANGUAGE plpgsql;

-- Helper: check if agent is quiescent
CREATE OR REPLACE FUNCTION is_agent_quiescent(p_agent_id uuid)
RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM agent_idle_state
    WHERE agent_id = p_agent_id AND state = 'quiescent'
  );
$$ LANGUAGE sql STABLE;

-- Helper: wake agent from quiescent (resets state to active)
CREATE OR REPLACE FUNCTION wake_agent_from_quiescent(p_agent_id uuid)
RETURNS void AS $$
  UPDATE agent_idle_state
  SET
    state = 'active',
    empty_heartbeat_streak = 0,
    next_watchdog_at = NULL,
    updated_at = NOW()
  WHERE agent_id = p_agent_id AND state = 'quiescent';
$$ LANGUAGE sql;

-- Helper: reschedule watchdog for a quiescent agent
CREATE OR REPLACE FUNCTION reschedule_watchdog(p_agent_id uuid, p_next_at timestamptz)
RETURNS void AS $$
  UPDATE agent_idle_state
  SET next_watchdog_at = p_next_at, updated_at = NOW()
  WHERE agent_id = p_agent_id;
$$ LANGUAGE sql;

-- Get all agents due for watchdog wake
CREATE OR REPLACE FUNCTION get_watchdog_due_agents()
RETURNS TABLE(agent_id uuid) AS $$
  SELECT agent_id FROM agent_idle_state
  WHERE state = 'quiescent'
    AND next_watchdog_at IS NOT NULL
    AND next_watchdog_at <= NOW();
$$ LANGUAGE sql STABLE;
