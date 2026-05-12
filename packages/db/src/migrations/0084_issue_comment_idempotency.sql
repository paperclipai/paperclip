ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
WITH unique_run_comments AS (
  SELECT
    "id",
    "issue_id",
    "created_by_run_id",
    count(*) OVER (PARTITION BY "issue_id", "created_by_run_id") AS run_comment_count
  FROM "issue_comments"
  WHERE "idempotency_key" IS NULL
    AND "created_by_run_id" IS NOT NULL
)
UPDATE "issue_comments" comments
SET "idempotency_key" = encode(sha256(convert_to(unique_run_comments."created_by_run_id"::text || ':' || unique_run_comments."issue_id"::text || ':' || comments."body", 'UTF8')), 'hex')
FROM unique_run_comments
WHERE comments."id" = unique_run_comments."id"
  AND unique_run_comments.run_comment_count = 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issue_comments_idempotency_key_uq"
  ON "issue_comments" USING btree ("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
