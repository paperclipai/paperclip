CREATE TABLE IF NOT EXISTS "company_skill_mutation_receipts" (
	"company_id" uuid NOT NULL,
	"key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"skill_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'company_skill_mutation_receipts_company_id_companies_id_fk'
      AND conrelid = 'company_skill_mutation_receipts'::regclass) THEN
    ALTER TABLE "company_skill_mutation_receipts" ADD CONSTRAINT "company_skill_mutation_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_skill_mutation_receipts_key_idx" ON "company_skill_mutation_receipts" USING btree ("company_id","key");
