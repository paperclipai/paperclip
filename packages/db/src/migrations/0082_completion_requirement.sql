ALTER TABLE "issues" ADD COLUMN "completion_requirement" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "expected_work_product" jsonb;