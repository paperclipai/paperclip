ALTER TABLE "cost_adjustments" ADD COLUMN IF NOT EXISTS "previous_usage_json" jsonb;--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "reported_usage_json" jsonb;