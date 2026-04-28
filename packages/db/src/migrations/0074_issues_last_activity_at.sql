-- Materialized issues.last_activity_at column to make the inbox-archive
-- visibility predicate sargable. Previously inboxVisibleForUserCondition
-- compared archived_at against a per-row dynamic expression involving
-- correlated subqueries over issue_comments / issue_read_states / activity_log,
-- which forced Postgres to re-evaluate those subqueries for every row scanned.
--
-- last_activity_at is maintained by:
--   1. A BEFORE INSERT trigger on issues that fills last_activity_at from
--      updated_at when the caller didn't pass an explicit value.
--   2. A BEFORE UPDATE trigger on issues that mirrors any updated_at change
--      into last_activity_at, so all of the existing update(issues) call
--      sites automatically keep it fresh without per-call instrumentation.
--   3. An AFTER INSERT trigger on issue_comments that bumps the parent
--      issue's last_activity_at to the new comment's created_at.
--
-- read-state changes (issue_read_states) intentionally do NOT bump activity:
-- they are per-user view state, not activity on the issue.

-- Add the column. Use a temporary DEFAULT so existing rows can be created
-- without violating NOT NULL during the ALTER. The default is dropped after
-- backfill so the BEFORE INSERT trigger has full control over the value.
ALTER TABLE "issues"
  ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint

-- Backfill last_activity_at = max(updated_at, created_at, latest comment, latest non-local-inbox activity log).
UPDATE "issues" AS i
SET "last_activity_at" = GREATEST(
  i."updated_at",
  i."created_at",
  COALESCE(
    (
      SELECT MAX(c."created_at")
      FROM "issue_comments" c
      WHERE c."issue_id" = i."id"
        AND c."company_id" = i."company_id"
    ),
    to_timestamp(0)
  ),
  COALESCE(
    (
      SELECT MAX(al."created_at")
      FROM "activity_log" al
      WHERE al."company_id" = i."company_id"
        AND al."entity_type" = 'issue'
        AND al."entity_id" = i."id"::text
        AND al."action" NOT IN (
          'issue.read_marked',
          'issue.read_unmarked',
          'issue.inbox_archived',
          'issue.inbox_unarchived'
        )
    ),
    to_timestamp(0)
  )
);
--> statement-breakpoint

ALTER TABLE "issues"
  ALTER COLUMN "last_activity_at" SET NOT NULL;
--> statement-breakpoint

-- Drop the temporary column default. The BEFORE INSERT trigger below fills
-- last_activity_at from updated_at when the caller didn't pass an explicit
-- value, so we don't want the Postgres column default to interfere with the
-- trigger logic (it would shadow caller-supplied historical timestamps).
ALTER TABLE "issues"
  ALTER COLUMN "last_activity_at" DROP DEFAULT;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "issues_company_last_activity_idx"
  ON "issues" USING btree ("company_id", "last_activity_at" DESC);
--> statement-breakpoint

-- BEFORE INSERT trigger: when last_activity_at was not explicitly provided,
-- mirror it from updated_at. This keeps the column NOT NULL constraint
-- satisfied while letting historical fixtures (and any future importer that
-- backfills updated_at to a past time) establish the right activity baseline.
CREATE OR REPLACE FUNCTION "issues_init_last_activity_at"() RETURNS trigger AS $$
BEGIN
  IF NEW."last_activity_at" IS NULL THEN
    NEW."last_activity_at" = NEW."updated_at";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "issues_init_last_activity_at_trigger" ON "issues";
--> statement-breakpoint

CREATE TRIGGER "issues_init_last_activity_at_trigger"
  BEFORE INSERT ON "issues"
  FOR EACH ROW
  EXECUTE FUNCTION "issues_init_last_activity_at"();
--> statement-breakpoint

-- BEFORE UPDATE trigger: when updated_at advances, advance last_activity_at to
-- match. This makes every existing `db.update(issues).set({ updatedAt: ... })`
-- callsite automatically maintain last_activity_at without code changes.
CREATE OR REPLACE FUNCTION "issues_sync_last_activity_at"() RETURNS trigger AS $$
BEGIN
  IF NEW."updated_at" IS DISTINCT FROM OLD."updated_at" THEN
    -- Only auto-advance if the caller didn't already provide an explicit
    -- last_activity_at update (so callers can override if they need to).
    IF NEW."last_activity_at" IS NOT DISTINCT FROM OLD."last_activity_at" THEN
      NEW."last_activity_at" = GREATEST(
        COALESCE(NEW."last_activity_at", to_timestamp(0)),
        NEW."updated_at"
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "issues_sync_last_activity_at_trigger" ON "issues";
--> statement-breakpoint

CREATE TRIGGER "issues_sync_last_activity_at_trigger"
  BEFORE UPDATE ON "issues"
  FOR EACH ROW
  EXECUTE FUNCTION "issues_sync_last_activity_at"();
--> statement-breakpoint

-- AFTER INSERT trigger on issue_comments: bump parent issue's last_activity_at.
CREATE OR REPLACE FUNCTION "issue_comments_bump_issue_last_activity_at"() RETURNS trigger AS $$
BEGIN
  UPDATE "issues"
  SET "last_activity_at" = NEW."created_at"
  WHERE "id" = NEW."issue_id"
    AND "last_activity_at" < NEW."created_at";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "issue_comments_bump_issue_last_activity_at_trigger" ON "issue_comments";
--> statement-breakpoint

CREATE TRIGGER "issue_comments_bump_issue_last_activity_at_trigger"
  AFTER INSERT ON "issue_comments"
  FOR EACH ROW
  EXECUTE FUNCTION "issue_comments_bump_issue_last_activity_at"();
