ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "cost_scale_factor" real DEFAULT 1.0 NOT NULL;
