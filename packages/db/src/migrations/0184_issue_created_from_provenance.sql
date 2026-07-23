ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "created_from_issue_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint"
    WHERE "conname" = 'issues_created_from_issue_id_issues_id_fk'
  ) THEN
    ALTER TABLE "issues"
      ADD CONSTRAINT "issues_created_from_issue_id_issues_id_fk"
      FOREIGN KEY ("created_from_issue_id")
      REFERENCES "public"."issues"("id")
      ON DELETE set null
      ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_created_from_issue_idx" ON "issues" USING btree ("created_from_issue_id");--> statement-breakpoint
UPDATE "issues" AS target
SET "created_from_issue_id" = source."id"
FROM "issues" AS source
WHERE target."created_from_issue_id" IS NULL
  AND target."origin_kind" LIKE 'task_watchdog%'
  AND target."origin_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  AND source."id" = target."origin_id"::uuid
  AND source."company_id" = target."company_id";
