DROP TABLE IF EXISTS "run_responsible_user_updated_at_sweeps";
--> statement-breakpoint
CREATE TEMP TABLE "run_responsible_user_updated_at_sweeps" ON COMMIT DROP AS
SELECT i."company_id", i."updated_at" AS "sweep_at"
FROM "issues" AS i
WHERE EXISTS (
    SELECT 1
    FROM "heartbeat_runs" AS h
    WHERE h."company_id" = i."company_id"
      AND h."updated_at" = i."updated_at"
  )
  AND EXISTS (
    SELECT 1
    FROM "companies" AS c
    WHERE c."id" = i."company_id"
      AND c."updated_at" = i."updated_at"
  )
GROUP BY i."company_id", i."updated_at"
HAVING count(*) > 100;
--> statement-breakpoint
UPDATE "issues" AS i
SET "updated_at" = GREATEST(
  i."created_at",
  COALESCE(CASE WHEN i."started_at" <= sweep."sweep_at" THEN i."started_at" END, i."created_at"),
  COALESCE(CASE WHEN i."completed_at" <= sweep."sweep_at" THEN i."completed_at" END, i."created_at"),
  COALESCE(CASE WHEN i."cancelled_at" <= sweep."sweep_at" THEN i."cancelled_at" END, i."created_at"),
  COALESCE(CASE WHEN i."monitor_wake_requested_at" <= sweep."sweep_at" THEN i."monitor_wake_requested_at" END, i."created_at"),
  COALESCE(CASE WHEN i."monitor_last_triggered_at" <= sweep."sweep_at" THEN i."monitor_last_triggered_at" END, i."created_at"),
  COALESCE(
    (
      SELECT max(GREATEST(c."created_at", c."updated_at"))
      FROM "issue_comments" AS c
      WHERE c."company_id" = i."company_id"
        AND c."issue_id" = i."id"
        AND c."created_at" <= sweep."sweep_at"
        AND c."updated_at" <= sweep."sweep_at"
    ),
    i."created_at"
  )
)
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE i."company_id" = sweep."company_id"
  AND i."updated_at" = sweep."sweep_at";
--> statement-breakpoint
UPDATE "heartbeat_runs" AS h
SET "updated_at" = GREATEST(
  h."created_at",
  COALESCE(CASE WHEN h."started_at" <= sweep."sweep_at" THEN h."started_at" END, h."created_at"),
  COALESCE(CASE WHEN h."process_started_at" <= sweep."sweep_at" THEN h."process_started_at" END, h."created_at"),
  COALESCE(CASE WHEN h."last_output_at" <= sweep."sweep_at" THEN h."last_output_at" END, h."created_at"),
  COALESCE(CASE WHEN h."scheduled_retry_at" <= sweep."sweep_at" THEN h."scheduled_retry_at" END, h."created_at"),
  COALESCE(CASE WHEN h."finished_at" <= sweep."sweep_at" THEN h."finished_at" END, h."created_at")
)
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE h."company_id" = sweep."company_id"
  AND h."updated_at" = sweep."sweep_at";
--> statement-breakpoint
UPDATE "routine_runs" AS rr
SET "updated_at" = GREATEST(
  rr."created_at",
  COALESCE(CASE WHEN rr."triggered_at" <= sweep."sweep_at" THEN rr."triggered_at" END, rr."created_at"),
  COALESCE(CASE WHEN rr."completed_at" <= sweep."sweep_at" THEN rr."completed_at" END, rr."created_at")
)
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE rr."company_id" = sweep."company_id"
  AND rr."updated_at" = sweep."sweep_at";
--> statement-breakpoint
UPDATE "routines" AS r
SET "updated_at" = GREATEST(
  r."created_at",
  COALESCE(CASE WHEN r."last_triggered_at" <= sweep."sweep_at" THEN r."last_triggered_at" END, r."created_at"),
  COALESCE(CASE WHEN r."last_enqueued_at" <= sweep."sweep_at" THEN r."last_enqueued_at" END, r."created_at")
)
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE r."company_id" = sweep."company_id"
  AND r."updated_at" = sweep."sweep_at";
--> statement-breakpoint
UPDATE "companies" AS c
SET "updated_at" = c."created_at"
FROM "run_responsible_user_updated_at_sweeps" AS sweep
WHERE c."id" = sweep."company_id"
  AND c."updated_at" = sweep."sweep_at";
--> statement-breakpoint
DROP TABLE IF EXISTS "run_responsible_user_updated_at_sweeps";
