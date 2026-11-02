ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "execution_control_deadline_at" timestamp with time zone;
