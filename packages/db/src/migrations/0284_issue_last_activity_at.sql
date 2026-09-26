ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone;--> statement-breakpoint
-- Keep `issues."last_activity_at"` at least as new as the row's own
-- `updated_at`, without ever moving it backwards. The three-way GREATEST is
-- what lets the comment and activity-log triggers below raise the column on
-- their own (they deliberately do not touch `updated_at`) and still survive a
-- later UPDATE of the issue row.
CREATE OR REPLACE FUNCTION paperclip_issue_last_activity_at()
RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		NEW."last_activity_at" := GREATEST(
			COALESCE(NEW."last_activity_at", to_timestamp(0)),
			NEW."updated_at"
		);
	ELSE
		NEW."last_activity_at" := GREATEST(
			COALESCE(NEW."last_activity_at", to_timestamp(0)),
			COALESCE(OLD."last_activity_at", to_timestamp(0)),
			NEW."updated_at"
		);
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_issue_last_activity_trigger ON "issues";--> statement-breakpoint
CREATE TRIGGER paperclip_issue_last_activity_trigger
BEFORE INSERT OR UPDATE ON "issues"
FOR EACH ROW EXECUTE FUNCTION paperclip_issue_last_activity_at();--> statement-breakpoint
-- A new comment is activity on its issue. The UPDATE is guarded so it only
-- matches when the column would actually move forward: an unconditional
-- GREATEST() write is a no-op on the value but still writes a new tuple version
-- of the "issues" row, which means a dead tuple and a touch of every index on
-- the hot table this column exists to protect. Nothing can move backwards here
-- without the GREATEST, because the BEFORE trigger on "issues" above still
-- applies its three-way GREATEST to every write of the row.
-- When it does match, this takes a row lock on the issue for the duration of
-- the inserting transaction; commenting on an issue is already a per-issue
-- serial path, so this adds no contention that the comment ordering did not
-- already impose.
CREATE OR REPLACE FUNCTION paperclip_issue_last_activity_from_comment()
RETURNS trigger AS $$
BEGIN
	UPDATE "issues"
	SET "last_activity_at" = NEW."created_at"
	WHERE "id" = NEW."issue_id"
		AND "company_id" = NEW."company_id"
		AND ("last_activity_at" IS NULL OR "last_activity_at" < NEW."created_at");
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_issue_comment_last_activity_trigger ON "issue_comments";--> statement-breakpoint
CREATE TRIGGER paperclip_issue_comment_last_activity_trigger
AFTER INSERT ON "issue_comments"
FOR EACH ROW EXECUTE FUNCTION paperclip_issue_last_activity_from_comment();--> statement-breakpoint
-- Activity-log rows about an issue count too, except the four per-user inbox
-- actions, which are a reader's private bookkeeping rather than activity on the
-- issue. `entity_id` is a text column shared by every entity type, so the WHEN
-- clause admits only issue-shaped ids: a malformed id simply does not match and
-- the activity-log insert is never put at risk by a failed cast.
-- Same forward-only guard as the comment trigger, and it matters more here: the
-- application's own `UPDATE issues SET updated_at = …` usually lands in the
-- same transaction just before the `issue.*` log row, so without the guard the
-- common case would write a second, identical-valued tuple version every time.
CREATE OR REPLACE FUNCTION paperclip_issue_last_activity_from_activity_log()
RETURNS trigger AS $$
BEGIN
	UPDATE "issues"
	SET "last_activity_at" = NEW."created_at"
	WHERE "id" = NEW."entity_id"::uuid
		AND "company_id" = NEW."company_id"
		AND ("last_activity_at" IS NULL OR "last_activity_at" < NEW."created_at");
	RETURN NULL;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_activity_log_issue_last_activity_trigger ON "activity_log";--> statement-breakpoint
CREATE TRIGGER paperclip_activity_log_issue_last_activity_trigger
AFTER INSERT ON "activity_log"
FOR EACH ROW
WHEN (
	NEW."entity_type" = 'issue'
	AND NEW."action" NOT IN (
		'issue.read_marked',
		'issue.read_unmarked',
		'issue.inbox_archived',
		'issue.inbox_unarchived'
	)
	AND NEW."entity_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
)
EXECUTE FUNCTION paperclip_issue_last_activity_from_activity_log();--> statement-breakpoint
-- Temporary support for the forward-only backfill. The keyset loop below
-- advances over this partial index by issue id, so each unbackfilled slice is
-- visited once instead of re-scanning "issues" from the beginning per batch.
CREATE INDEX IF NOT EXISTS "issues_last_activity_backfill_idx"
	ON "issues" USING btree ("id")
	WHERE "last_activity_at" IS NULL;--> statement-breakpoint
ANALYZE "issues";--> statement-breakpoint
-- Backfill: the expression the issue list used to evaluate per row, per query,
-- as three correlated subqueries. Evaluated once here instead.
DO $$
DECLARE
	last_issue_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
	next_issue_id uuid;
BEGIN
	LOOP
		next_issue_id := NULL;

		WITH batch AS MATERIALIZED (
			SELECT i."id"
			FROM "issues" i
			WHERE i."id" > last_issue_id
				AND i."last_activity_at" IS NULL
			ORDER BY i."id"
			LIMIT 5000
		),
		updated AS (
			UPDATE "issues" i
			SET "last_activity_at" = GREATEST(
				i."updated_at",
				COALESCE((
					SELECT MAX(c."created_at")
					FROM "issue_comments" c
					WHERE c."issue_id" = i."id"
						AND c."company_id" = i."company_id"
				), to_timestamp(0)),
				COALESCE((
					SELECT MAX(a."created_at")
					FROM "activity_log" a
					WHERE a."company_id" = i."company_id"
						AND a."entity_type" = 'issue'
						AND a."entity_id" = i."id"::text
						AND a."action" NOT IN (
							'issue.read_marked',
							'issue.read_unmarked',
							'issue.inbox_archived',
							'issue.inbox_unarchived'
						)
				), to_timestamp(0))
			)
			FROM batch b
			WHERE i."id" = b."id"
			RETURNING i."id"
		)
		SELECT b."id"
		INTO next_issue_id
		FROM batch b
		ORDER BY b."id" DESC
		LIMIT 1;

		EXIT WHEN next_issue_id IS NULL;
		last_issue_id := next_issue_id;
	END LOOP;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "issues_last_activity_backfill_idx";--> statement-breakpoint
-- Built after the backfill so it is created over populated data. Column order
-- matches the issue-list ORDER BY exactly, `updated_at` fallback included.
CREATE INDEX IF NOT EXISTS "issues_company_last_activity_idx" ON "issues" USING btree ("company_id",COALESCE("last_activity_at", "updated_at") DESC,"updated_at" DESC,"id" DESC);
