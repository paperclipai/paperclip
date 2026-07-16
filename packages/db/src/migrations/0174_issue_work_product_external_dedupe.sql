DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "issue_work_products"
    WHERE "external_id" IS NOT NULL
    GROUP BY "company_id", "issue_id", "provider", "external_id"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add work product dedupe index: duplicate external identities exist';
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_work_products_company_issue_provider_external_id_uq"
ON "issue_work_products" USING btree ("company_id", "issue_id", "provider", "external_id")
WHERE "external_id" IS NOT NULL;
