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
-- Backfill agent attribution for historical non-human ("Board") comments so old
-- threads stop rendering as blue board bubbles and the read path stops
-- re-scanning run logs. Two SQL-computable tiers, both guarded to NEVER touch a
-- comment whose author maps to a genuine user profile. The log-marker tier is
-- handled lazily on read (it needs object-storage log bodies).
--
-- Tier `run_id`: the comment's own authoring run resolves to an agent (lossless).
-- Batched to keep lock/WAL footprint bounded on large histories.
DO $$
DECLARE
	affected integer;
BEGIN
	LOOP
		WITH batch AS (
			SELECT c.id AS comment_id, hr.agent_id, hr.id AS run_id
			FROM issue_comments c
			JOIN heartbeat_runs hr ON hr.id = c.created_by_run_id
			WHERE c.author_agent_id IS NULL
				AND c.derived_author_agent_id IS NULL
				AND c.author_user_id IS NOT NULL
				-- Only the non-human board sentinel or non-`user` authors are
				-- eligible. `local-board` IS a row in "user" (the implicit board
				-- admin), so it must be allowed explicitly; genuine signups are not.
				AND (c.author_user_id = 'local-board'
					OR NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = c.author_user_id))
			LIMIT 5000
		)
		UPDATE issue_comments c
		SET derived_author_agent_id = b.agent_id,
			derived_created_by_run_id = b.run_id,
			derived_author_source = 'run_id'
		FROM batch b
		WHERE c.id = b.comment_id;
		GET DIAGNOSTICS affected = ROW_COUNT;
		EXIT WHEN affected = 0;
	END LOOP;
END $$;--> statement-breakpoint
-- Option A: the pure run-window TIMING tiers are intentionally NOT applied.
-- Because agents post through the `local-board` subprocess, an agent comment and
-- a genuine human board comment are indistinguishable rows, so any timing-overlap
-- guess mis-attributes human board comments that merely coincided with an agent
-- run (e.g. a human board reply typed while an agent run was in flight).
-- Only the lossless `run_id` backfill above (and the read-path `run_log_comment_post`
-- tier) attribute history; everything else stays "Board".
--
-- This statement also reverts any attribution a PRIOR revision of this migration
-- persisted via the timing tiers, so re-applying / upgrading is idempotent.
UPDATE issue_comments
SET derived_author_agent_id = NULL,
	derived_created_by_run_id = NULL,
	derived_author_source = NULL
WHERE derived_author_source IN ('run_window_unique', 'run_window_agent_unique');
