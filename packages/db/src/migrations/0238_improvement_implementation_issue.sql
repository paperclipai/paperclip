ALTER TABLE "improvement_suggestions" ADD COLUMN IF NOT EXISTS "implementation_issue_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'improvement_suggestions_implementation_issue_id_issues_id_fk') THEN
  ALTER TABLE "improvement_suggestions" ADD CONSTRAINT "improvement_suggestions_implementation_issue_id_issues_id_fk" FOREIGN KEY ("implementation_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "improvement_suggestions_implementation_issue_idx" ON "improvement_suggestions" USING btree ("implementation_issue_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_improvement_suggestion_origin_uq" ON "issues" USING btree ("company_id", "origin_kind", "origin_id") WHERE "origin_kind" = 'improvement_suggestion' AND "origin_id" IS NOT NULL AND "hidden_at" IS NULL;
