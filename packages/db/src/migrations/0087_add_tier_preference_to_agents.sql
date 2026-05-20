ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "tier_preference" text DEFAULT 'default' NOT NULL;
