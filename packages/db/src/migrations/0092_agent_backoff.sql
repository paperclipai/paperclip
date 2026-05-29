-- Per-agent error backoff fields.
-- consecutive_failure_count: cleared to 0 on success, capped at 6 (= 32 min backoff).
-- backoff_until: when set, scheduled (timer-source) wakes skip until this passes.
--                Manual / on_demand / assignment / automation wakes bypass.
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "consecutive_failure_count" integer NOT NULL DEFAULT 0;
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "backoff_until" timestamp with time zone;
