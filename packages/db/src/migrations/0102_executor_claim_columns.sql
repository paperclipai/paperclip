ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "claimed_by" text;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "executor_heartbeat_at" timestamptz;
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "claim_attempts" integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "heartbeat_runs_queued_claim_idx" ON "heartbeat_runs" ("status", "created_at") WHERE "status" = 'queued';
