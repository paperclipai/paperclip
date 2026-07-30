ALTER TABLE "issues"
ADD COLUMN IF NOT EXISTS "close_contract" jsonb;
