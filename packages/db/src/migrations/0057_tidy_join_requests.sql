WITH ranked_user_requests AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, requesting_user_id
      ORDER BY created_at ASC, id ASC
    ) AS rank
  FROM join_requests
  WHERE request_type = 'human'
    AND status = 'pending_approval'
    AND requesting_user_id IS NOT NULL
)
UPDATE join_requests
SET
  status = 'rejected',
  rejected_at = COALESCE(rejected_at, now()),
  updated_at = now()
WHERE id IN (
  SELECT id
  FROM ranked_user_requests
  WHERE rank > 1
);
--> statement-breakpoint
WITH ranked_email_requests AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY company_id, lower(request_email_snapshot)
      ORDER BY created_at ASC, id ASC
    ) AS rank
  FROM join_requests
  WHERE request_type = 'human'
    AND status = 'pending_approval'
    AND request_email_snapshot IS NOT NULL
)
UPDATE join_requests
SET
  status = 'rejected',
  rejected_at = COALESCE(rejected_at, now()),
  updated_at = now()
WHERE id IN (
  SELECT id
  FROM ranked_email_requests
  WHERE rank > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "join_requests_pending_human_user_uq"
ON "join_requests" USING btree ("company_id", "requesting_user_id")
WHERE "request_type" = 'human'
  AND "status" = 'pending_approval'
  AND "requesting_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "join_requests_pending_human_email_uq"
ON "join_requests" USING btree ("company_id", lower("request_email_snapshot"))
WHERE "request_type" = 'human'
  AND "status" = 'pending_approval'
  AND "request_email_snapshot" IS NOT NULL;
