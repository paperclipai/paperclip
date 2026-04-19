ALTER TABLE "issues" ADD COLUMN "board_position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
WITH ranked_issues AS (
  SELECT
    "issues"."id",
    row_number() OVER (
      PARTITION BY "issues"."company_id", "issues"."status"
      ORDER BY
        CASE "issues"."priority"
          WHEN 'critical' THEN 0
          WHEN 'high' THEN 1
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 3
          ELSE 4
        END,
        GREATEST(
          "issues"."updated_at",
          COALESCE(
            (
              SELECT MAX("issue_comments"."created_at")
              FROM "issue_comments"
              WHERE "issue_comments"."issue_id" = "issues"."id"
                AND "issue_comments"."company_id" = "issues"."company_id"
            ),
            to_timestamp(0)
          ),
          COALESCE(
            (
              SELECT MAX("activity_log"."created_at")
              FROM "activity_log"
              WHERE "activity_log"."company_id" = "issues"."company_id"
                AND "activity_log"."entity_type" = 'issue'
                AND "activity_log"."entity_id" = "issues"."id"::text
                AND "activity_log"."action" NOT IN (
                  'issue.read_marked',
                  'issue.read_unmarked',
                  'issue.inbox_archived',
                  'issue.inbox_unarchived'
                )
            ),
            to_timestamp(0)
          )
        ) DESC,
        "issues"."updated_at" DESC,
        "issues"."created_at" DESC,
        "issues"."id"
    ) - 1 AS "board_position"
  FROM "issues"
)
UPDATE "issues"
SET "board_position" = "ranked_issues"."board_position"
FROM "ranked_issues"
WHERE "issues"."id" = "ranked_issues"."id";--> statement-breakpoint
CREATE INDEX "issues_company_status_board_position_idx" ON "issues" USING btree ("company_id","status","board_position");
