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
SET "default_responsible_user_id" = owner_defaults."user_id"
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
SET "responsible_user_id" = resolved_issue_users."user_id"
FROM resolved_issue_users
WHERE i."id" = resolved_issue_users."issue_id"
  AND i."responsible_user_id" IS NULL;
--> statement-breakpoint
UPDATE "issues" AS i
SET "responsible_user_id" = c."default_responsible_user_id"
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
SET "responsible_user_id" = routine_responsible_users."user_id"
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
SET "responsible_user_id" = routine_run_responsible_users."user_id"
FROM routine_run_responsible_users
WHERE rr."id" = routine_run_responsible_users."id"
  AND routine_run_responsible_users."user_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = original."responsible_user_id"
FROM "heartbeat_runs" AS original
WHERE h."retry_of_run_id" = original."id"
  AND h."company_id" = original."company_id"
  AND h."responsible_user_id" IS NULL
  AND original."responsible_user_id" IS NOT NULL;
--> statement-breakpoint
WITH extracted_run_refs AS (
  SELECT
    h."id" AS "run_id",
    h."company_id",
    NULLIF(h."context_snapshot" ->> 'issueId', '') AS "issue_ref",
    1 AS "ref_priority"
  FROM "heartbeat_runs" AS h
  WHERE h."responsible_user_id" IS NULL
    AND NULLIF(h."context_snapshot" ->> 'issueId', '') IS NOT NULL

  UNION ALL

  SELECT
    h."id" AS "run_id",
    h."company_id",
    NULLIF(h."context_snapshot" ->> 'taskId', '') AS "issue_ref",
    2 AS "ref_priority"
  FROM "heartbeat_runs" AS h
  WHERE h."responsible_user_id" IS NULL
    AND NULLIF(h."context_snapshot" ->> 'taskId', '') IS NOT NULL
),
uuid_run_refs AS (
  SELECT
    "run_id",
    "company_id",
    "issue_ref"::uuid AS "issue_id",
    "ref_priority"
  FROM extracted_run_refs
  WHERE "issue_ref" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
resolved_run_users AS (
  SELECT DISTINCT ON ("run_id")
    "run_id",
    "responsible_user_id"
  FROM (
    SELECT
      refs."run_id",
      i."responsible_user_id",
      refs."ref_priority",
      1 AS "match_priority"
    FROM uuid_run_refs AS refs
    JOIN "issues" AS i
      ON i."id" = refs."issue_id"
     AND i."company_id" = refs."company_id"
    WHERE i."responsible_user_id" IS NOT NULL

    UNION ALL

    SELECT
      refs."run_id",
      i."responsible_user_id",
      refs."ref_priority",
      2 AS "match_priority"
    FROM extracted_run_refs AS refs
    JOIN "issues" AS i
      ON i."identifier" = refs."issue_ref"
     AND i."company_id" = refs."company_id"
    WHERE refs."issue_ref" IS NOT NULL
      AND i."responsible_user_id" IS NOT NULL
  ) AS candidates
  ORDER BY "run_id", "ref_priority" ASC, "match_priority" ASC
)
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = resolved_run_users."responsible_user_id"
FROM resolved_run_users
WHERE h."id" = resolved_run_users."run_id"
  AND h."responsible_user_id" IS NULL;
--> statement-breakpoint
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = awr."requested_by_actor_id"
FROM "agent_wakeup_requests" AS awr
WHERE h."wakeup_request_id" = awr."id"
  AND h."company_id" = awr."company_id"
  AND h."responsible_user_id" IS NULL
  AND awr."requested_by_actor_type" = 'user'
  AND awr."requested_by_actor_id" IS NOT NULL;
--> statement-breakpoint
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = c."default_responsible_user_id"
FROM "companies" AS c
WHERE h."company_id" = c."id"
  AND h."responsible_user_id" IS NULL
  AND c."default_responsible_user_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "companies_default_responsible_user_idx"
  ON "companies" ("default_responsible_user_id");
