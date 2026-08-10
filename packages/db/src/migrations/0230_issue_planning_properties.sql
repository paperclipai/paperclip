ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "story_points" integer;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "estimate_hours" integer;
