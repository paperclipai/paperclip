ALTER TABLE "heartbeat_runs"
  ADD COLUMN IF NOT EXISTS "sleep_boundary_crossed" boolean DEFAULT false NOT NULL;
