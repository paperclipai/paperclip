ALTER TABLE "workspace_operations" ADD COLUMN IF NOT EXISTS "issue_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'workspace_operations_issue_id_issues_id_fk'
	) THEN
		ALTER TABLE "workspace_operations" ADD CONSTRAINT "workspace_operations_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
WITH "run_issue_candidates" AS (
	SELECT
		"heartbeat_runs"."id" AS "run_id",
		"heartbeat_runs"."company_id" AS "company_id",
		CASE
			WHEN "heartbeat_runs"."context_snapshot" ? 'issueId'
				AND "heartbeat_runs"."context_snapshot"->>'issueId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
			THEN ("heartbeat_runs"."context_snapshot"->>'issueId')::uuid
			ELSE NULL
		END AS "issue_id"
	FROM "heartbeat_runs"
),
"run_issue_attribution" AS (
	SELECT
		"run_issue_candidates"."run_id",
		"issues"."id" AS "issue_id"
	FROM "run_issue_candidates"
	INNER JOIN "issues"
		ON "issues"."id" = "run_issue_candidates"."issue_id"
		AND "issues"."company_id" = "run_issue_candidates"."company_id"
	WHERE "run_issue_candidates"."issue_id" IS NOT NULL
)
UPDATE "workspace_operations"
SET
	"issue_id" = "run_issue_attribution"."issue_id",
	"updated_at" = now()
FROM "run_issue_attribution"
WHERE "workspace_operations"."heartbeat_run_id" = "run_issue_attribution"."run_id"
	AND "workspace_operations"."issue_id" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_operations_company_workspace_issue_started_idx" ON "workspace_operations" USING btree ("company_id","execution_workspace_id","issue_id","started_at");
