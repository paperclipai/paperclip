DROP TABLE IF EXISTS "run_responsible_user_updated_at_sweeps";
--> statement-breakpoint
CREATE TEMP TABLE "run_responsible_user_updated_at_sweeps" ON COMMIT DROP AS
SELECT i."updated_at" AS "sweep_at"
FROM "issues" AS i
WHERE EXISTS (
    SELECT 1
    FROM "heartbeat_runs" AS h
    WHERE h."updated_at" = i."updated_at"
  )
  AND EXISTS (
    SELECT 1
    FROM "companies" AS c
    WHERE c."updated_at" = i."updated_at"
  )
GROUP BY i."updated_at"
HAVING count(*) > 100;
--> statement-breakpoint
UPDATE "issues" AS i
SET "updated_at" = GREATEST(
  i."created_at",
  COALESCE(
    (
      SELECT max(c."created_at")
      FROM "issue_comments" AS c
      WHERE c."company_id" = i."company_id"
        AND c."issue_id" = i."id"
        AND c."created_at" <= sweep."sweep_at"
    ),
    i."created_at"
  )
)
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE i."updated_at" = sweep."sweep_at";
--> statement-breakpoint
UPDATE "heartbeat_runs" AS h
SET "updated_at" = GREATEST(
  h."created_at",
  COALESCE(
    CASE WHEN h."finished_at" <= sweep."sweep_at" THEN h."finished_at" END,
    CASE WHEN h."started_at" <= sweep."sweep_at" THEN h."started_at" END,
    h."created_at"
  )
)
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE h."updated_at" = sweep."sweep_at";
--> statement-breakpoint
UPDATE "routine_runs" AS rr
SET "updated_at" = GREATEST(
  rr."created_at",
  COALESCE(
    CASE WHEN rr."completed_at" <= sweep."sweep_at" THEN rr."completed_at" END,
    rr."created_at"
  )
)
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE rr."updated_at" = sweep."sweep_at";
--> statement-breakpoint
UPDATE "routines" AS r
SET "updated_at" = r."created_at"
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE r."updated_at" = sweep."sweep_at";
--> statement-breakpoint
UPDATE "companies" AS c
SET "updated_at" = c."created_at"
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE c."updated_at" = sweep."sweep_at";
--> statement-breakpoint
DROP TABLE IF EXISTS "run_responsible_user_updated_at_sweeps";
