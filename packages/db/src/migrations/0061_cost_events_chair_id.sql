-- Telemetry (D0 empirical seat-cap proof): per-chair dimension on cost_events.
-- chair_id = subscription seat identity (adapterConfig.env.CLAUDE_CONFIG_DIR); null for API-key runs.
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "chair_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cost_events_company_chair_occurred_idx" ON "cost_events" ("company_id","chair_id","occurred_at");
