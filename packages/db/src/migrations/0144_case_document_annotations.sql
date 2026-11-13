ALTER TABLE "document_annotation_threads" ADD COLUMN IF NOT EXISTS "case_id" uuid;
--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD COLUMN IF NOT EXISTS "case_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_case_id_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
ALTER TABLE "document_annotation_threads" DROP CONSTRAINT IF EXISTS "document_annotation_threads_owner_check";
--> statement-breakpoint
ALTER TABLE "document_annotation_threads" DROP CONSTRAINT IF EXISTS "document_annotation_threads_exactly_one_owner_chk";
--> statement-breakpoint
ALTER TABLE "document_annotation_threads" ADD CONSTRAINT "document_annotation_threads_exactly_one_owner_chk" CHECK (num_nonnulls("issue_id", "routine_id", "case_id") = 1);
--> statement-breakpoint
ALTER TABLE "document_annotation_comments" DROP CONSTRAINT IF EXISTS "document_annotation_comments_owner_check";
--> statement-breakpoint
ALTER TABLE "document_annotation_comments" DROP CONSTRAINT IF EXISTS "document_annotation_comments_exactly_one_owner_chk";
--> statement-breakpoint
ALTER TABLE "document_annotation_comments" ADD CONSTRAINT "document_annotation_comments_exactly_one_owner_chk" CHECK (num_nonnulls("issue_id", "routine_id", "case_id") = 1);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_annotation_threads_company_case_status_idx" ON "document_annotation_threads" USING btree ("company_id","case_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_annotation_comments_company_case_created_at_idx" ON "document_annotation_comments" USING btree ("company_id","case_id","created_at");
