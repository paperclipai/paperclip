ALTER TABLE "issues" ADD COLUMN "origin_issue_id" uuid;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_origin_issue_id_issues_id_fk" FOREIGN KEY ("origin_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "issues_company_origin_issue_idx" ON "issues" USING btree ("company_id","origin_issue_id");