ALTER TABLE "clients" ADD COLUMN "metadata" jsonb;
--> statement-breakpoint
UPDATE "clients"
SET "metadata" = jsonb_strip_nulls(
  coalesce("metadata", '{}'::jsonb) ||
  jsonb_build_object(
    'cnpj',
    "cnpj"
  )
)
WHERE "cnpj" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "clients" DROP COLUMN "cnpj";
--> statement-breakpoint
ALTER TABLE "client_projects" ADD COLUMN "metadata" jsonb;
--> statement-breakpoint
UPDATE "client_projects"
SET "metadata" = jsonb_strip_nulls(
  coalesce("metadata", '{}'::jsonb) ||
  jsonb_build_object(
    'legacyProjectType',
    "project_type",
    'legacyBillingType',
    "billing_type",
    'legacyAmountCents',
    "amount_cents",
    'legacyLastPaymentAt',
    CASE
      WHEN "last_payment_at" IS NULL THEN NULL
      ELSE to_jsonb("last_payment_at")
    END
  )
)
WHERE "project_type" IS NOT NULL
  OR "billing_type" IS NOT NULL
  OR "amount_cents" IS NOT NULL
  OR "last_payment_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "client_projects" DROP COLUMN "project_type";
--> statement-breakpoint
ALTER TABLE "client_projects" DROP COLUMN "billing_type";
--> statement-breakpoint
ALTER TABLE "client_projects" DROP COLUMN "amount_cents";
--> statement-breakpoint
ALTER TABLE "client_projects" DROP COLUMN "last_payment_at";
--> statement-breakpoint
DELETE FROM "client_projects" cp
USING (
  SELECT ctid
  FROM (
    SELECT
      ctid,
      row_number() OVER (
        PARTITION BY "client_id", "project_id"
        ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
      ) AS rn
    FROM "client_projects"
  ) ranked
  WHERE ranked.rn > 1
) duplicates
WHERE cp.ctid = duplicates.ctid;
--> statement-breakpoint
CREATE UNIQUE INDEX "client_projects_client_project_unique"
ON "client_projects" USING btree ("client_id","project_id");
