-- VOG-6111: Horizon Scan infrastructure — additive migration, independently revertible
-- Extends agent_wakeup_requests with wake_kind dispatch priority and traceability fields

ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "wake_kind" VARCHAR(20) NOT NULL DEFAULT 'cron';
ALTER TABLE "agent_wakeup_requests" ADD COLUMN IF NOT EXISTS "source_run_id" UUID REFERENCES "heartbeat_runs"("id");

CREATE UNIQUE INDEX IF NOT EXISTS "agent_wakeup_requests_idempotency_key_unique" ON "agent_wakeup_requests"("idempotency_key") WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "agent_wakeup_requests_agent_kind_requested_idx" ON "agent_wakeup_requests"("agent_id", "wake_kind", "requested_at");

-- Horizon scan configuration per agent
CREATE TABLE IF NOT EXISTS "agent_horizon_config" (
  "agent_id" UUID PRIMARY KEY REFERENCES "agents"("id"),
  "enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "scan_interval_seconds" INT NOT NULL DEFAULT 900,
  "p0_stall_hours" DOUBLE PRECISION NOT NULL DEFAULT 4.0,
  "p1_stall_hours" DOUBLE PRECISION NOT NULL DEFAULT 24.0,
  "engineer_stall_l1_hours" DOUBLE PRECISION NOT NULL DEFAULT 24.0,
  "engineer_stall_l2_hours" DOUBLE PRECISION NOT NULL DEFAULT 48.0,
  "engineer_review_zombie_hours" DOUBLE PRECISION NOT NULL DEFAULT 72.0,
  "outstanding_ask_minutes" INT NOT NULL DEFAULT 30,
  "board_wait_escalate_minutes" INT NOT NULL DEFAULT 60,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
