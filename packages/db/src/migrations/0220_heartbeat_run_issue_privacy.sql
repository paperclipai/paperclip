ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "issue_id" uuid;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "scope_kind" text NOT NULL DEFAULT 'company';
--> statement-breakpoint
-- A retry can encounter the trigger from an earlier partial application. Keep
-- it out of the way while unresolved legacy claims are marked fail-closed.
DROP TRIGGER IF EXISTS "heartbeat_runs_set_scope_kind" ON "heartbeat_runs";
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" DROP CONSTRAINT IF EXISTS "heartbeat_runs_scope_binding_check";
--> statement-breakpoint
-- Temporary support for the forward-only keyset backfill. Every row whose
-- snapshot claims an issue is classified as issue-scoped before constraints
-- are installed. Unresolvable claims deliberately fail the migration below.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_context_issue_backfill_idx"
  ON "heartbeat_runs" USING btree ("id")
  WHERE ("scope_kind" <> 'issue' OR "issue_id" IS NULL)
    AND ("issue_id" IS NOT NULL OR "context_snapshot" ? 'issueId');
--> statement-breakpoint
ANALYZE "heartbeat_runs";
--> statement-breakpoint
DO $$
DECLARE
  last_run_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
  next_last_run_id uuid;
BEGIN
  LOOP
    next_last_run_id := NULL;

    WITH batch AS MATERIALIZED (
      SELECT
        "run"."id" AS run_id,
        (
          SELECT "issue"."id"
          FROM "issues" AS "issue"
          WHERE "issue"."company_id" = "run"."company_id"
            AND "issue"."id" = COALESCE(
              "run"."issue_id",
              CASE
                WHEN "run"."context_snapshot"->>'issueId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
                  THEN ("run"."context_snapshot"->>'issueId')::uuid
                ELSE NULL
              END
            )
          LIMIT 1
        ) AS resolved_issue_id
      FROM "heartbeat_runs" AS "run"
      WHERE "run"."id" > last_run_id
        AND ("run"."scope_kind" <> 'issue' OR "run"."issue_id" IS NULL)
        AND ("run"."issue_id" IS NOT NULL OR "run"."context_snapshot" ? 'issueId')
      ORDER BY "run"."id"
      LIMIT 5000
    ),
    updated AS (
      UPDATE "heartbeat_runs" AS "run"
      SET "scope_kind" = 'issue',
          "issue_id" = "batch"."resolved_issue_id"
      FROM "batch"
      WHERE "run"."id" = "batch"."run_id"
      RETURNING "run"."id"
    )
    SELECT "batch"."run_id"
    INTO next_last_run_id
    FROM "batch"
    LEFT JOIN "updated" ON "updated"."id" = "batch"."run_id"
    ORDER BY "batch"."run_id" DESC
    LIMIT 1;

    EXIT WHEN next_last_run_id IS NULL;
    last_run_id := next_last_run_id;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  unresolved_count bigint;
BEGIN
  SELECT count(*)
  INTO unresolved_count
  FROM "heartbeat_runs"
  WHERE "scope_kind" = 'issue' AND "issue_id" IS NULL;

  IF unresolved_count > 0 THEN
    RAISE EXCEPTION 'heartbeat run privacy backfill found % unresolved issue-scoped run(s); repair their issue binding before retrying migration 0220', unresolved_count;
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX IF EXISTS "heartbeat_runs_context_issue_backfill_idx";
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" DROP CONSTRAINT IF EXISTS "heartbeat_runs_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD CONSTRAINT "heartbeat_runs_issue_id_issues_id_fk"
  FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" VALIDATE CONSTRAINT "heartbeat_runs_issue_id_issues_id_fk";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "set_heartbeat_run_scope_kind"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW."scope_kind" := CASE
    WHEN NEW."issue_id" IS NOT NULL THEN 'issue'
    WHEN TG_OP = 'UPDATE' AND OLD."scope_kind" = 'issue' THEN 'issue'
    ELSE 'company'
  END;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "heartbeat_runs_set_scope_kind" ON "heartbeat_runs";
--> statement-breakpoint
CREATE TRIGGER "heartbeat_runs_set_scope_kind"
BEFORE INSERT OR UPDATE OF "issue_id" ON "heartbeat_runs"
FOR EACH ROW EXECUTE FUNCTION "set_heartbeat_run_scope_kind"();
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" DROP CONSTRAINT IF EXISTS "heartbeat_runs_scope_binding_check";
--> statement-breakpoint
ALTER TABLE "heartbeat_runs"
  ADD CONSTRAINT "heartbeat_runs_scope_binding_check"
  CHECK (
    ("scope_kind" = 'company' AND "issue_id" IS NULL)
    OR "scope_kind" = 'issue'
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" VALIDATE CONSTRAINT "heartbeat_runs_scope_binding_check";
--> statement-breakpoint
ALTER TABLE "workspace_operations" DROP CONSTRAINT IF EXISTS "workspace_operations_heartbeat_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_operations"
  ADD CONSTRAINT "workspace_operations_heartbeat_run_id_heartbeat_runs_id_fk"
  FOREIGN KEY ("heartbeat_run_id") REFERENCES "public"."heartbeat_runs"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE "workspace_operations" VALIDATE CONSTRAINT "workspace_operations_heartbeat_run_id_heartbeat_runs_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_operations" DROP CONSTRAINT IF EXISTS "workspace_operations_issue_id_issues_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_operations"
  ADD CONSTRAINT "workspace_operations_issue_id_issues_id_fk"
  FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
--> statement-breakpoint
ALTER TABLE "workspace_operations" VALIDATE CONSTRAINT "workspace_operations_issue_id_issues_id_fk";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_issue_created_idx"
  ON "heartbeat_runs" USING btree ("company_id", "issue_id", "created_at");
