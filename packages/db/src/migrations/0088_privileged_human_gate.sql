ALTER TABLE "issues"
ADD COLUMN IF NOT EXISTS "privileged_human_gate" jsonb;
