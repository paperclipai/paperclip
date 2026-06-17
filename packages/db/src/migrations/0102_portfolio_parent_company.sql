ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "parent_company_id" uuid;--> statement-breakpoint
DO $$
BEGIN
 IF NOT EXISTS (
  SELECT 1
  FROM pg_constraint
  WHERE conname = 'companies_parent_company_id_companies_id_fk'
 ) THEN
  ALTER TABLE "companies"
    ADD CONSTRAINT "companies_parent_company_id_companies_id_fk"
    FOREIGN KEY ("parent_company_id")
    REFERENCES "public"."companies"("id")
    ON DELETE set null
    ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_parent_company_id_idx" ON "companies" USING btree ("parent_company_id");
