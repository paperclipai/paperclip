ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "title_needs_generation" boolean DEFAULT false NOT NULL;
