ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "superseded_by_id" uuid REFERENCES "issues"("id");
