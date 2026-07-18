ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "auth_context" jsonb;
