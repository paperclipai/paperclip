ALTER TABLE "issues" ADD COLUMN "success_criteria" jsonb;
ALTER TABLE "issues" ADD COLUMN "minimum_verification" jsonb;
ALTER TABLE "issues" ADD COLUMN "expected_output" text;
ALTER TABLE "issues" ADD COLUMN "out_of_scope" jsonb;
ALTER TABLE "issues" ADD COLUMN "estimate" jsonb;
ALTER TABLE "issues" ADD COLUMN "phase" text;
CREATE INDEX "issues_company_phase_idx" ON "issues" USING btree ("company_id","phase");
