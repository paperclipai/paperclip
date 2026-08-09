ALTER TABLE "agent_api_keys" ADD COLUMN IF NOT EXISTS "session_bound_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_api_keys" ADD COLUMN IF NOT EXISTS "session_bound_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_api_keys_session_bound_run_id_idx" ON "agent_api_keys" ("session_bound_run_id");
