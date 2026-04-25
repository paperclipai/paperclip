-- Phase 0.8: Context cache + diff loading
-- Agent wake doesn't reload full context every time. Cut heartbeat tokens ~5K.

CREATE TABLE IF NOT EXISTS "agent_context_cache" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "last_context" jsonb NOT NULL,
  "last_loaded_at" timestamptz NOT NULL,
  "cached_at_xact_id" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "fetch_on_demand" boolean NOT NULL DEFAULT false,
  "summary" text,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_context_cache_agent_id_uq" ON "agent_context_cache" ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_context_cache_expires_at_idx" ON "agent_context_cache" USING btree ("expires_at");

-- Helper: get or create context cache for an agent
CREATE OR REPLACE FUNCTION get_or_create_agent_context_cache(p_agent_id uuid)
RETURNS agent_context_cache AS $$
DECLARE
  v_cache agent_context_cache%ROWTYPE;
BEGIN
  SELECT * INTO v_cache FROM agent_context_cache WHERE agent_id = p_agent_id;
  IF v_cache.id IS NULL THEN
    INSERT INTO agent_context_cache (agent_id, last_context, last_loaded_at, cached_at_xact_id, expires_at, fetch_on_demand)
    VALUES (p_agent_id, '{}'::jsonb, NOW(), txid_current_snapshot()::text, NOW() + INTERVAL '1 hour', false)
    RETURNING * INTO v_cache;
  END IF;
  RETURN v_cache;
END;
$$ LANGUAGE plpgsql;

-- Helper: check if context cache is fresh (same transaction snapshot)
CREATE OR REPLACE FUNCTION is_context_cache_fresh(p_agent_id uuid)
RETURNS boolean AS $$
DECLARE
  v_cache agent_context_cache%ROWTYPE;
  v_current_xact_id text;
BEGIN
  SELECT * INTO v_cache FROM agent_context_cache WHERE agent_id = p_agent_id;
  IF v_cache.id IS NULL THEN
    RETURN false;
  END IF;
  -- Compare transaction snapshots - cache is fresh if same snapshot
  v_current_xact_id := txid_current_snapshot()::text;
  RETURN v_cache.cached_at_xact_id = v_current_xact_id;
END;
$$ LANGUAGE plpgsql STABLE;

-- Helper: check if context cache is expired
CREATE OR REPLACE FUNCTION is_context_cache_expired(p_agent_id uuid)
RETURNS boolean AS $$
DECLARE
  v_cache agent_context_cache%ROWTYPE;
BEGIN
  SELECT * INTO v_cache FROM agent_context_cache WHERE agent_id = p_agent_id;
  IF v_cache.id IS NULL THEN
    RETURN true;
  END IF;
  RETURN v_cache.expires_at <= NOW();
END;
$$ LANGUAGE plpgsql STABLE;

-- Helper: invalidate context cache for an agent
CREATE OR REPLACE FUNCTION invalidate_agent_context_cache(p_agent_id uuid)
RETURNS void AS $$
BEGIN
  DELETE FROM agent_context_cache WHERE agent_id = p_agent_id;
END;
$$ LANGUAGE sql;

-- Helper: update context cache for an agent
CREATE OR REPLACE FUNCTION update_agent_context_cache(
  p_agent_id uuid,
  p_last_context jsonb,
  p_fetch_on_demand boolean DEFAULT false,
  p_summary text DEFAULT NULL
)
RETURNS agent_context_cache AS $$
DECLARE
  v_cache agent_context_cache%ROWTYPE;
BEGIN
  UPDATE agent_context_cache
  SET
    last_context = p_last_context,
    last_loaded_at = NOW(),
    cached_at_xact_id = txid_current_snapshot()::text,
    expires_at = NOW() + INTERVAL '1 hour',
    fetch_on_demand = p_fetch_on_demand,
    summary = p_summary,
    updated_at = NOW()
  WHERE agent_id = p_agent_id
  RETURNING * INTO v_cache;
  RETURN v_cache;
END;
$$ LANGUAGE plpgsql;

-- Cleanup: delete expired caches (run periodically)
CREATE OR REPLACE FUNCTION cleanup_expired_context_caches()
RETURNS integer AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM agent_context_cache WHERE expires_at <= NOW();
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;
