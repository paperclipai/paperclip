DELETE FROM "issue_work_products" loser
USING "issue_work_products" keeper
WHERE loser."company_id" = keeper."company_id"
  AND loser."issue_id" = keeper."issue_id"
  AND loser."type" = keeper."type"
  AND loser."provider" = keeper."provider"
  AND loser."external_id" = keeper."external_id"
  AND (
    keeper."updated_at" > loser."updated_at"
    OR (
      keeper."updated_at" = loser."updated_at"
      AND keeper."id"::text > loser."id"::text
    )
  );--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_work_products_company_issue_identity_uq"
  ON "issue_work_products" USING btree ("company_id", "issue_id", "type", "provider", "external_id");
