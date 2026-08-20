-- JAC-4538: Add publication_approval_id to issue_work_products for publication contract.
--
-- The schema definition in issue_work_products.ts includes publicationApprovalId
-- (referencing approvals.id), but no migration was generated to add the column
-- to the live database. This caused a PostgresError (column does not exist) when
-- the ORM attempted to SELECT from issue_work_products, resulting in HTTP 500
-- on /api/issues/{id} and timeout during Plan Runner execution.
--> statement-breakpoint

ALTER TABLE "issue_work_products"
  ADD COLUMN IF NOT EXISTS "publication_approval_id" uuid REFERENCES "approvals" ("id") ON DELETE SET NULL;

COMMENT ON COLUMN "issue_work_products"."publication_approval_id" IS
  'FK to approvals - set when this work product was created from an approved publish_full_artifact approval (JAC-4538).';
