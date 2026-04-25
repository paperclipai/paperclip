-- Phase 0.5: Dispatcher (quota + idle aware)
-- Dynamic task routing by quality_rank × quota_available × task_complexity

-- Tracks per-subscription quota windows and their current usage.
-- Used by the dispatcher to route tasks to the best available agent
-- without exceeding subscription headroom.
CREATE TABLE IF NOT EXISTS "subscription_quotas" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subscription" text NOT NULL,
  "provider" text NOT NULL,
  "window_start" timestamptz NOT NULL,
  "window_end" timestamptz NOT NULL,
  "used_messages" integer NOT NULL DEFAULT 0,
  "used_tokens" bigint NOT NULL DEFAULT 0,
  "capacity_messages" integer NOT NULL,
  "capacity_tokens" bigint NOT NULL,
  "utilization_cap" real NOT NULL DEFAULT 0.70,
  "is_saturated" boolean NOT NULL DEFAULT false,
  "last_updated" timestamptz NOT NULL DEFAULT NOW(),
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE ("subscription", "window_start")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_quotas_subscription_idx" ON "subscription_quotas" USING btree ("subscription");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_quotas_window_idx" ON "subscription_quotas" USING btree ("window_start", "window_end") WHERE "is_saturated" = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_quotas_saturated_idx" ON "subscription_quotas" USING btree ("subscription", "is_saturated") WHERE "is_saturated" = false;

-- Maps roles to ranked model/harness candidates with their subscription.
-- Dispatcher selects best candidate per-task using:
--   score = quality_rank × quota_available × task_complexity_factor
-- Lower task_complexity (easier task) → higher multiplier → better score.
CREATE TABLE IF NOT EXISTS "agent_role_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "role" text NOT NULL,
  "model" text NOT NULL,
  "harness" text NOT NULL,
  "subscription" text NOT NULL,
  "provider" text NOT NULL,
  "quality_rank" real NOT NULL DEFAULT 1.00,
  "is_saturated" boolean NOT NULL DEFAULT false,
  "last_used_at" timestamptz,
  "consecutive_failures" integer NOT NULL DEFAULT 0,
  "created_at" timestamptz NOT NULL DEFAULT NOW(),
  "updated_at" timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE ("role", "model", "harness")
);
--> statement-breakonne
CREATE INDEX IF NOT EXISTS "agent_role_candidates_role_idx" ON "agent_role_candidates" USING btree ("role") WHERE "is_saturated" = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_role_candidates_subscription_idx" ON "agent_role_candidates" USING btree ("subscription", "is_saturated") WHERE "is_saturated" = false;

-- Advisory lock key generator for race-safe dispatch.
-- Each subscription gets a deterministic lock key to prevent
-- concurrent dispatch from exceeding quota.
CREATE OR REPLACE FUNCTION subscription_lock_key(p_subscription text)
RETURNS bigint AS $$
  SELECT ('x' || substr(md5(p_subscription), 1, 16))::bit(64)::bigint;
$$ LANGUAGE sql IMMUTABLE STRICT;

-- Marks a subscription as saturated when rate_limit is hit.
-- Saturated candidates fall through to next in rank order.
CREATE OR REPLACE FUNCTION mark_subscription_saturated(p_subscription text)
RETURNS void AS $$
  UPDATE subscription_quotas
  SET is_saturated = true, last_updated = NOW()
  WHERE subscription = p_subscription AND window_end > NOW();
$$ LANGUAGE sql;

-- Resets saturation flag at window boundary (call from cron or event).
CREATE OR REPLACE FUNCTION reset_saturated_subscriptions()
RETURNS SETOF subscription_quotas AS $$
  UPDATE subscription_quotas
  SET is_saturated = false, last_updated = NOW()
  WHERE window_end <= NOW() AND is_saturated = true
  RETURNING *;
$$ LANGUAGE sql;

-- Atomically checks quota and decrements if within cap.
-- Returns true if dispatch is allowed, false if cap would be exceeded.
-- Uses advisory lock on subscription to prevent race conditions.
CREATE OR REPLACE FUNCTION try_reserve_quota(
  p_subscription text,
  p_messages integer DEFAULT 1,
  p_tokens bigint DEFAULT 0
) RETURNS boolean AS $$
DECLARE
  v_lock_key bigint;
  v_row subscription_quotas%ROWTYPE;
  v_allowed boolean := false;
BEGIN
  v_lock_key := subscription_lock_key(p_subscription);

  IF NOT pg_try_advisory_xact_lock(v_lock_key) THEN
    RETURN false;
  END IF;

  SELECT * INTO v_row
  FROM subscription_quotas
  WHERE subscription = p_subscription
    AND window_start <= NOW()
    AND window_end > NOW()
    AND is_saturated = false
  FOR UPDATE;

  IF v_row IS NULL THEN
    RETURN false;
  END IF;

  -- Check if adding this usage would exceed the utilization cap
  IF (
    (v_row.used_messages + p_messages) <= (v_row.capacity_messages * v_row.utilization_cap)::integer
    AND (v_row.used_tokens + p_tokens) <= (v_row.capacity_tokens * v_row.utilization_cap)::bigint
  ) THEN
    UPDATE subscription_quotas
    SET
      used_messages = used_messages + p_messages,
      used_tokens = used_tokens + p_tokens,
      last_updated = NOW()
    WHERE id = v_row.id;
    v_allowed := true;
  ELSE
    -- Mark as saturated so next candidate is tried
    UPDATE subscription_quotas
    SET is_saturated = true, last_updated = NOW()
    WHERE id = v_row.id;
    v_allowed := false;
  END IF;

  RETURN v_allowed;
END;
$$ LANGUAGE plpgsql;

-- Increments failure counter on a candidate; resets on success.
-- After 3 consecutive failures, marks candidate saturated.
CREATE OR REPLACE FUNCTION record_candidate_failure(
  p_role text,
  p_model text,
  p_harness text
) RETURNS void AS $$
  UPDATE agent_role_candidates
  SET
    consecutive_failures = consecutive_failures + 1,
    is_saturated = CASE WHEN consecutive_failures >= 2 THEN true ELSE is_saturated END,
    updated_at = NOW()
  WHERE role = p_role AND model = p_model AND harness = p_harness;
$$ LANGUAGE sql;

-- Resets failure counter on successful dispatch.
CREATE OR REPLACE FUNCTION record_candidate_success(
  p_role text,
  p_model text,
  p_harness text
) RETURNS void AS $$
  UPDATE agent_role_candidates
  SET
    consecutive_failures = 0,
    last_used_at = NOW(),
    updated_at = NOW()
  WHERE role = p_role AND model = p_model AND harness = p_harness;
$$ LANGUAGE sql;