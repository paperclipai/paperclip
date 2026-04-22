ALTER TABLE "issues" ADD COLUMN "due_date" date;--> statement-breakpoint
CREATE INDEX "issues_company_due_date_idx" ON "issues" USING btree ("company_id","due_date");
