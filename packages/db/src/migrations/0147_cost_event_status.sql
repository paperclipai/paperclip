ALTER TABLE "cost_events" ADD COLUMN IF NOT EXISTS "cost_status" text DEFAULT 'reported' NOT NULL;
