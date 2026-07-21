ALTER TABLE "cost_events"
ADD COLUMN IF NOT EXISTS "usage_basis" text DEFAULT 'unknown' NOT NULL;
