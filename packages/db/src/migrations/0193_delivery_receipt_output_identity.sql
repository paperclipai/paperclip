ALTER TABLE "issue_delivery_receipts" ADD COLUMN "output_digest" text;
UPDATE "issue_delivery_receipts"
SET "output_digest" = 'legacy:' || "id"::text
WHERE "output_digest" IS NULL;
ALTER TABLE "issue_delivery_receipts" ALTER COLUMN "output_digest" SET NOT NULL;
DROP INDEX "issue_delivery_receipts_identity_uq";
CREATE UNIQUE INDEX "issue_delivery_receipts_identity_uq"
  ON "issue_delivery_receipts" ("company_id", "source_issue_id", "primary_work_product_key", "revision", "output_digest");
