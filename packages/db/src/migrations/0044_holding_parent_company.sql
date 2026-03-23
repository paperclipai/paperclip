ALTER TABLE "companies" ADD COLUMN "parent_company_id" uuid REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "companies_parent_company_idx" ON "companies" USING btree ("parent_company_id");
