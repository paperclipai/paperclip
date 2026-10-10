CREATE TABLE IF NOT EXISTS "routine_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"snapshot" jsonb NOT NULL,
	"change_summary" text,
	"restored_from_revision_id" uuid,
	"created_by_agent_id" uuid,
	"created_by_user_id" text,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "latest_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "latest_revision_number" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_restored_from_revision_id_routine_revisions_id_fk" FOREIGN KEY ("restored_from_revision_id") REFERENCES "public"."routine_revisions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "routine_revisions" ADD CONSTRAINT "routine_revisions_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "routine_revisions_routine_revision_uq" ON "routine_revisions" USING btree ("routine_id","revision_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "routine_revisions_company_routine_created_idx" ON "routine_revisions" USING btree ("company_id","routine_id","created_at");
--> statement-breakpoint
WITH inserted_revisions AS (
	INSERT INTO "routine_revisions" (
		"id",
		"company_id",
		"routine_id",
		"revision_number",
		"title",
		"description",
		"snapshot",
		"change_summary",
		"created_by_agent_id",
		"created_by_user_id",
		"created_at"
	)
	SELECT
		gen_random_uuid(),
		r."company_id",
		r."id",
		1,
		r."title",
		r."description",
		jsonb_build_object(
			'version', 1,
			'routine', jsonb_build_object(
				'id', r."id",
				'companyId', r."company_id",
				'projectId', r."project_id",
				'goalId', r."goal_id",
				'parentIssueId', r."parent_issue_id",
				'title', r."title",
				'description', r."description",
				'assigneeAgentId', r."assignee_agent_id",
				'priority', r."priority",
				'status', r."status",
				'concurrencyPolicy', r."concurrency_policy",
				'catchUpPolicy', r."catch_up_policy",
				'variables', coalesce(r."variables", '[]'::jsonb)
			),
			'triggers', coalesce(
				(
					SELECT jsonb_agg(
						jsonb_build_object(
							'id', rt."id",
							'kind', rt."kind",
							'label', rt."label",
							'enabled', rt."enabled",
							'cronExpression', rt."cron_expression",
							'timezone', rt."timezone",
							'publicId', rt."public_id",
							'signingMode', rt."signing_mode",
							'replayWindowSec', rt."replay_window_sec"
						)
						ORDER BY rt."created_at", rt."id"
					)
					FROM "routine_triggers" rt
					WHERE rt."routine_id" = r."id"
						AND rt."company_id" = r."company_id"
				),
				'[]'::jsonb
			)
		),
		'Initial routine revision backfill',
		r."created_by_agent_id",
		r."created_by_user_id",
		r."created_at"
	FROM "routines" r
	WHERE NOT EXISTS (
		SELECT 1
		FROM "routine_revisions" rr
		WHERE rr."routine_id" = r."id"
			AND rr."revision_number" = 1
	)
	RETURNING "id", "routine_id"
)
UPDATE "routines" r
SET
	"latest_revision_id" = inserted_revisions."id",
	"latest_revision_number" = 1
FROM inserted_revisions
WHERE r."id" = inserted_revisions."routine_id";
--> statement-breakpoint
UPDATE "routines" r
SET
	"latest_revision_id" = rr."id",
	"latest_revision_number" = rr."revision_number"
FROM "routine_revisions" rr
WHERE rr."routine_id" = r."id"
	AND rr."revision_number" = 1
	AND r."latest_revision_id" IS NULL;
