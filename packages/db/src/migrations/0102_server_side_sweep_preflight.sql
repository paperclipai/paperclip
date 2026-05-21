ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "feature_flags" jsonb NOT NULL DEFAULT '{}'::jsonb;
