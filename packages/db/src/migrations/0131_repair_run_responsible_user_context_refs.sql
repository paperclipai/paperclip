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
    WHERE i."responsible_user_id" IS NOT NULL
  ) AS candidates
  ORDER BY "run_id", "ref_priority" ASC, "match_priority" ASC
)
UPDATE "heartbeat_runs" AS h
SET "responsible_user_id" = resolved_run_users."responsible_user_id",
    "updated_at" = now()
FROM resolved_run_users
WHERE h."id" = resolved_run_users."run_id"
  AND h."responsible_user_id" IS NULL;
