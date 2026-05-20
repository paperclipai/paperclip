ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "complexity" text DEFAULT 'normal' NOT NULL;
