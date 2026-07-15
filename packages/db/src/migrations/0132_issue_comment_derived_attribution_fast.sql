ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "derived_author_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "derived_created_by_run_id" uuid;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "derived_author_source" text;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'issue_comments_derived_author_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_derived_author_agent_id_agents_id_fk" FOREIGN KEY ("derived_author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'issue_comments_derived_created_by_run_id_heartbeat_runs_id_fk'
	) THEN
		ALTER TABLE "issue_comments" ADD CONSTRAINT "issue_comments_derived_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("derived_created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
-- Temporary support for the forward-only backfill. The keyset loop below
-- advances over this partial index by comment id, so each eligible slice is
-- visited once instead of re-scanning issue_comments from the beginning on
-- every batch.
CREATE INDEX IF NOT EXISTS "issue_comments_derived_attribution_backfill_idx"
	ON "issue_comments" USING btree ("id")
	WHERE "author_agent_id" IS NULL
		AND "derived_author_agent_id" IS NULL
		AND "author_user_id" IS NOT NULL
		AND "created_by_run_id" IS NOT NULL;--> statement-breakpoint
ANALYZE "issue_comments";--> statement-breakpoint
DO $$
DECLARE
	last_comment_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
	next_last_comment_id uuid;
BEGIN
	LOOP
		next_last_comment_id := NULL;

		WITH batch AS MATERIALIZED (
			SELECT c."id" AS comment_id, hr."agent_id", hr."id" AS run_id
			FROM "issue_comments" c
			JOIN "heartbeat_runs" hr ON hr."id" = c."created_by_run_id"
			LEFT JOIN "user" u ON u."id" = c."author_user_id"
			WHERE c."id" > last_comment_id
				AND c."author_agent_id" IS NULL
				AND c."derived_author_agent_id" IS NULL
				AND c."author_user_id" IS NOT NULL
				AND c."created_by_run_id" IS NOT NULL
				AND (
					c."author_user_id" = 'local-board'
					OR u."id" IS NULL
				)
			ORDER BY c."id"
			LIMIT 5000
		),
		updated AS (
			UPDATE "issue_comments" c
			SET "derived_author_agent_id" = b."agent_id",
				"derived_created_by_run_id" = b."run_id",
				"derived_author_source" = 'run_id'
			FROM batch b
			WHERE c."id" = b."comment_id"
			RETURNING c."id"
		)
		SELECT b."comment_id"
		INTO next_last_comment_id
		FROM batch b
		LEFT JOIN updated u ON u."id" = b."comment_id"
		ORDER BY b."comment_id" DESC
		LIMIT 1;

		EXIT WHEN next_last_comment_id IS NULL;
		last_comment_id := next_last_comment_id;
	END LOOP;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "issue_comments_derived_attribution_backfill_idx";--> statement-breakpoint
-- Keep the Option-A cleanup at the end as well, matching the original 0126
-- terminal state if any timing-tier rows are introduced before this migration
-- is retried.
UPDATE "issue_comments"
SET "derived_author_agent_id" = NULL,
	"derived_created_by_run_id" = NULL,
	"derived_author_source" = NULL
WHERE "derived_author_source" IN ('run_window_unique', 'run_window_agent_unique');
