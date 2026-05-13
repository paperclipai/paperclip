ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "last_ping_at" timestamp with time zone;
