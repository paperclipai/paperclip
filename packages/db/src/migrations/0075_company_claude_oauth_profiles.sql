ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "claude_oauth_profiles" jsonb DEFAULT '[]'::jsonb NOT NULL;
