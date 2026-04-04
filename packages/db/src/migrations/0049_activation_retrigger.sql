ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "activation_retrigger_count" integer NOT NULL DEFAULT 0;
