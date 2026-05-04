-- Allow company_secrets to be instance-scoped (company_id IS NULL).
-- See packages/db/src/schema/company_secrets.ts for the partial-unique-index
-- pair that keeps per-company-name uniqueness AND a single instance namespace.

ALTER TABLE "company_secrets" ALTER COLUMN "company_id" DROP NOT NULL;--> statement-breakpoint
DROP INDEX "company_secrets_company_name_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "company_secrets_company_name_uq"
  ON "company_secrets" USING btree ("company_id", "name")
  WHERE "company_secrets"."company_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "company_secrets_instance_name_uq"
  ON "company_secrets" USING btree ("name")
  WHERE "company_secrets"."company_id" IS NULL;
