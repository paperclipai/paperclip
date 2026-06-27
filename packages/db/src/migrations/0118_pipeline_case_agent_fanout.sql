ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "parent_case_version" integer;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "request_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_cases_parent_request_key_uq" ON "pipeline_cases" USING btree ("parent_case_id","request_key");
