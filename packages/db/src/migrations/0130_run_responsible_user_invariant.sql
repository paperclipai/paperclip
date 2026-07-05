ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "default_responsible_user_id" text;
--> statement-breakpoint
WITH owner_defaults AS (
  SELECT DISTINCT ON ("company_id")
    "company_id",
    "principal_id" AS "user_id"
  FROM "company_memberships"
  WHERE "principal_type" = 'user'
    AND "status" = 'active'
    AND "membership_role" = 'owner'
  ORDER BY "company_id", "created_at" ASC, "id" ASC
)
UPDATE "companies" AS c
SET "default_responsible_user_id" = owner_defaults."user_id",
    "updated_at" = now()
FROM owner_defaults
WHERE c."id" = owner_defaults."company_id"
  AND c."default_responsible_user_id" IS NULL;
--> statement-breakpoint
WITH RECURSIVE issue_chain AS (
  SELECT
    child."id" AS "issue_id",
    child."company_id",
    child."parent_id",
    child."responsible_user_id",
    child."created_by_user_id",
    0 AS "depth"
  FROM "issues" AS child
  WHERE child."responsible_user_id" IS NULL
  UNION ALL
  SELECT
    issue_chain."issue_id",
    parent."company_id",
    parent."parent_id",
    parent."responsible_user_id",
    parent."created_by_user_id",
    issue_chain."depth" + 1
  FROM issue_chain
  JOIN "issues" AS parent
    ON parent."id" = issue_chain."parent_id"
   AND parent."company_id" = issue_chain."company_id"
  WHERE issue_chain."depth" < 50
),
resolved_issue_users AS (
  SELECT DISTINCT ON ("issue_id")
    "issue_id",
    COALESCE("responsible_user_id", "created_by_user_id") AS "user_id"
  FROM issue_chain
  WHERE COALESCE("responsible_user_id", "created_by_user_id") IS NOT NULL
  ORDER BY "issue_id", "depth" ASC
)
UPDATE "issues" AS i
SET "responsible_user_id" = resolved_issue_users."user_id",
    "updated_at" = now()
FROM resolved_issue_users
WHERE i."id" = resolved_issue_users."issue_id"
  AND i."responsible_user_id" IS NULL;
--> statement-breakpoint
UPDATE "issues" AS i
SET "responsible_user_id" = c."default_responsible_user_id",
    "updated_at" = now()
FROM "companies" AS c
WHERE i."company_id" = c."id"
  AND i."responsible_user_id" IS NULL
  AND c."default_responsible_user_id" IS NOT NULL;
--> statement-breakpoint
WITH routine_responsible_users AS (
  SELECT
    r."id",
    COALESCE(r."created_by_user_id", parent_issue."responsible_user_id", c."default_responsible_user_id") AS "user_id"
  FROM "routines" AS r
  JOIN "companies" AS c ON c."id" = r."company_id"
  LEFT JOIN "issues" AS parent_issue
    ON parent_issue."id" = r."parent_issue_id"
   AND parent_issue."company_id" = r."company_id"
  WHERE r."responsible_user_id" IS NULL
)
UPDATE "routines" AS r
SET "responsible_user_id" = routine_responsible_users."user_id",
    "updated_at" = now()
FROM routine_responsible_users
WHERE r."id" = routine_responsible_users."id"
  AND routine_responsible_users."user_id" IS NOT NULL;
--> statement-breakpoint
WITH routine_revision_responsible_users AS (
  SELECT
    rr."id",
    COALESCE(rr."created_by_user_id", r."responsible_user_id", c."default_responsible_user_id") AS "user_id"
  FROM "routine_revisions" AS rr
  JOIN "routines" AS r
    ON rr."routine_id" = r."id"
   AND rr."company_id" = r."company_id"
  JOIN "companies" AS c ON c."id" = rr."company_id"
  WHERE rr."responsible_user_id" IS NULL
)
UPDATE "routine_revisions" AS rr
SET "responsible_user_id" = routine_revision_responsible_users."user_id"
FROM routine_revision_responsible_users
WHERE rr."id" = routine_revision_responsible_users."id"
  AND routine_revision_responsible_users."user_id" IS NOT NULL;
--> statement-breakpoint
WITH routine_run_responsible_users AS (
  SELECT
    rr."id",
    COALESCE(linked_issue."responsible_user_id", r."responsible_user_id", c."default_responsible_user_id") AS "user_id"
  FROM "routine_runs" AS rr
  JOIN "routines" AS r
    ON rr."routine_id" = r."id"
   AND rr."company_id" = r."company_id"
  JOIN "companies" AS c ON c."id" = rr."company_id"
  LEFT JOIN "issues" AS linked_issue
    ON linked_issue."id" = rr."linked_issue_id"
   AND linked_issue."company_id" = rr."company_id"
  WHERE rr."responsible_user_id" IS NULL
)
UPDATE "routine_runs" AS rr
SET "responsible_user_id" = routine_run_responsible_users."user_id",
    "updated_at" = now()
FROM routine_run_responsible_users
WHERE rr."id" = routine_run_responsible_users."id"
  AND routine_run_responsible_users."user_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = original."responsible_user_id",
    "updated_at" = now()
FROM "heartbeat_runs" AS original
WHERE h."retry_of_run_id" = original."id"
  AND h."company_id" = original."company_id"
  AND h."responsible_user_id" IS NULL
  AND original."responsible_user_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = i."responsible_user_id",
    "updated_at" = now()
FROM "issues" AS i
WHERE h."company_id" = i."company_id"
  AND h."responsible_user_id" IS NULL
  AND i."responsible_user_id" IS NOT NULL
  AND (
    h."context_snapshot" ->> 'issueId' = i."id"::text
    OR h."context_snapshot" ->> 'taskId' = i."id"::text
    OR h."context_snapshot" ->> 'issueId' = i."identifier"
    OR h."context_snapshot" ->> 'taskId' = i."identifier"
  );
--> statement-breakpoint
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = awr."requested_by_actor_id",
    "updated_at" = now()
FROM "agent_wakeup_requests" AS awr
WHERE h."wakeup_request_id" = awr."id"
  AND h."company_id" = awr."company_id"
  AND h."responsible_user_id" IS NULL
  AND awr."requested_by_actor_type" = 'user'
  AND awr."requested_by_actor_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = c."default_responsible_user_id",
    "updated_at" = now()
FROM "companies" AS c
WHERE h."company_id" = c."id"
  AND h."responsible_user_id" IS NULL
  AND c."default_responsible_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_default_responsible_user_idx"
  ON "companies" ("default_responsible_user_id");
