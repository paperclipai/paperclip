CREATE TABLE IF NOT EXISTS "pipeline_automation_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"automation_id" text NOT NULL,
	"triggering_event_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"status" text NOT NULL,
	"execution_issue_id" uuid,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_automation_executions_status_check" CHECK ("pipeline_automation_executions"."status" in ('succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_case_blockers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"blocked_by_case_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_case_blockers_no_self_block_check" CHECK ("pipeline_case_blockers"."case_id" <> "pipeline_case_blockers"."blocked_by_case_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_case_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_user_id" text,
	"actor_agent_id" uuid,
	"run_id" uuid,
	"from_stage_id" uuid,
	"to_stage_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_case_events_type_check" CHECK ("pipeline_case_events"."type" in (
        'ingested',
        'updated',
        'claimed',
        'lease_released',
        'lease_expired',
        'transitioned',
        'transition_suggested',
        'suggestion_resolved',
        'review_decided',
        'conversation_opened',
        'issue_linked',
        'automation_executed',
        'automation_failed',
        'blockers_set',
        'blockers_resolved',
        'children_terminal'
      )),
	CONSTRAINT "pipeline_case_events_actor_type_check" CHECK ("pipeline_case_events"."actor_type" in ('user', 'agent', 'system')),
	CONSTRAINT "pipeline_case_events_agent_run_check" CHECK ("pipeline_case_events"."actor_type" <> 'agent' or "pipeline_case_events"."run_id" is not null)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_case_issue_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"issue_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_by_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_case_issue_links_role_check" CHECK ("pipeline_case_issue_links"."role" in ('origin', 'conversation', 'work', 'automation'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"case_key" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workspace_ref" jsonb,
	"parent_case_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"pending_suggestion" jsonb,
	"lease_owner_type" text,
	"lease_agent_id" uuid,
	"lease_user_id" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"terminal_kind" text,
	"terminal_at" timestamp with time zone,
	"child_count" integer DEFAULT 0 NOT NULL,
	"terminal_child_count" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"origin_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_cases_terminal_kind_check" CHECK ("pipeline_cases"."terminal_kind" is null or "pipeline_cases"."terminal_kind" in ('done', 'cancelled')),
	CONSTRAINT "pipeline_cases_lease_owner_type_check" CHECK ("pipeline_cases"."lease_owner_type" is null or "pipeline_cases"."lease_owner_type" in ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"position" integer NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pipeline_stages_kind_check" CHECK ("pipeline_stages"."kind" in ('open', 'working', 'review', 'done', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"from_stage_id" uuid NOT NULL,
	"to_stage_id" uuid NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"enforce_transitions" boolean DEFAULT false NOT NULL,
	"created_by_user_id" text,
	"created_by_agent_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "project_id" uuid;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
UPDATE "pipelines"
SET "company_id" = "projects"."company_id"
FROM "projects"
WHERE "pipelines"."project_id" = "projects"."id"
  AND "pipelines"."company_id" IS NULL;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pipeline_cases'
      AND column_name = 'company_id'
  ) THEN
    UPDATE "pipelines"
    SET "company_id" = "case_companies"."company_id"
    FROM (
      SELECT "pipeline_id", (array_agg(DISTINCT "company_id"))[1] AS "company_id", count(DISTINCT "company_id") AS "company_count"
      FROM "pipeline_cases"
      WHERE "company_id" IS NOT NULL
      GROUP BY "pipeline_id"
    ) AS "case_companies"
    WHERE "pipelines"."id" = "case_companies"."pipeline_id"
      AND "case_companies"."company_count" = 1
      AND "pipelines"."company_id" IS NULL;
  END IF;
END $$;--> statement-breakpoint
UPDATE "pipelines"
SET "company_id" = "companies"."id"
FROM "companies"
WHERE "pipelines"."company_id" IS NULL
  AND (SELECT count(*) FROM "companies") = 1;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "pipelines" WHERE "company_id" IS NULL) THEN
    RAISE EXCEPTION 'Cannot backfill pipelines.company_id for existing rows without project, case, or single-company ownership';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "pipelines" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "key" text;--> statement-breakpoint
UPDATE "pipelines"
SET "key" = "id"::text
WHERE "key" IS NULL;--> statement-breakpoint
ALTER TABLE "pipelines" ALTER COLUMN "key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
UPDATE "pipeline_cases"
SET "company_id" = "pipelines"."company_id"
FROM "pipelines"
WHERE "pipeline_cases"."pipeline_id" = "pipelines"."id"
  AND "pipeline_cases"."company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "case_key" text;--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pipeline_cases'
      AND column_name = 'fields'
  ) THEN
    WITH candidates AS (
      SELECT
        "id",
        "pipeline_id",
        coalesce(
          nullif("fields"->>'caseKey', ''),
          nullif("fields"->>'case_key', ''),
          nullif("fields"->>'key', ''),
          nullif("fields"->>'externalKey', ''),
          nullif("fields"->>'external_key', '')
        ) AS "candidate"
      FROM "pipeline_cases"
      WHERE "case_key" IS NULL
    ),
    unique_candidates AS (
      SELECT
        "id",
        "candidate",
        count(*) OVER (PARTITION BY "pipeline_id", "candidate") AS "candidate_count"
      FROM candidates
      WHERE "candidate" IS NOT NULL
    )
    UPDATE "pipeline_cases"
    SET "case_key" = unique_candidates."candidate"
    FROM unique_candidates
    WHERE "pipeline_cases"."id" = unique_candidates."id"
      AND unique_candidates."candidate_count" = 1
      AND NOT EXISTS (
        SELECT 1
        FROM "pipeline_cases" AS "existing_cases"
        WHERE "existing_cases"."pipeline_id" = "pipeline_cases"."pipeline_id"
          AND "existing_cases"."case_key" = unique_candidates."candidate"
      );
  END IF;
END $$;--> statement-breakpoint
WITH candidates AS (
  SELECT
    "pipeline_cases"."id",
    "pipeline_cases"."pipeline_id",
    "issues"."identifier" AS "candidate"
  FROM "pipeline_cases"
  INNER JOIN "pipeline_case_issue_links"
    ON "pipeline_case_issue_links"."case_id" = "pipeline_cases"."id"
   AND "pipeline_case_issue_links"."role" = 'origin'
  INNER JOIN "issues"
    ON "issues"."id" = "pipeline_case_issue_links"."issue_id"
  WHERE "pipeline_cases"."case_key" IS NULL
    AND "issues"."identifier" IS NOT NULL
),
unique_candidates AS (
  SELECT
    "id",
    "candidate",
    count(*) OVER (PARTITION BY "pipeline_id", "candidate") AS "candidate_count"
  FROM candidates
)
UPDATE "pipeline_cases"
SET "case_key" = unique_candidates."candidate"
FROM unique_candidates
WHERE "pipeline_cases"."id" = unique_candidates."id"
  AND unique_candidates."candidate_count" = 1
  AND NOT EXISTS (
    SELECT 1
    FROM "pipeline_cases" AS "existing_cases"
    WHERE "existing_cases"."pipeline_id" = "pipeline_cases"."pipeline_id"
      AND "existing_cases"."case_key" = unique_candidates."candidate"
  );--> statement-breakpoint
UPDATE "pipeline_cases"
SET "case_key" = "id"::text
WHERE "case_key" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ALTER COLUMN "case_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "parent_case_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pipeline_automation_executions" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
UPDATE "pipeline_automation_executions"
SET "company_id" = "pipeline_cases"."company_id"
FROM "pipeline_cases"
WHERE "pipeline_automation_executions"."case_id" = "pipeline_cases"."id"
  AND "pipeline_automation_executions"."company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_automation_executions" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_blockers" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
UPDATE "pipeline_case_blockers"
SET "company_id" = "pipeline_cases"."company_id"
FROM "pipeline_cases"
WHERE "pipeline_case_blockers"."case_id" = "pipeline_cases"."id"
  AND "pipeline_case_blockers"."company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_blockers" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
UPDATE "pipeline_case_events"
SET "company_id" = "pipeline_cases"."company_id"
FROM "pipeline_cases"
WHERE "pipeline_case_events"."case_id" = "pipeline_cases"."id"
  AND "pipeline_case_events"."company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
UPDATE "pipeline_case_issue_links"
SET "company_id" = "pipeline_cases"."company_id"
FROM "pipeline_cases"
WHERE "pipeline_case_issue_links"."case_id" = "pipeline_cases"."id"
  AND "pipeline_case_issue_links"."company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_issue_links" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_documents" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
UPDATE "pipeline_documents"
SET "company_id" = "pipelines"."company_id"
FROM "pipelines"
WHERE "pipeline_documents"."pipeline_id" = "pipelines"."id"
  AND "pipeline_documents"."company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_documents" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD COLUMN IF NOT EXISTS "actor_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD COLUMN IF NOT EXISTS "type" text;--> statement-breakpoint
UPDATE "pipeline_case_events"
SET "type" = 'updated'
WHERE "type" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ALTER COLUMN "type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD COLUMN IF NOT EXISTS "actor_type" text;--> statement-breakpoint
UPDATE "pipeline_case_events"
SET "actor_type" = 'system'
WHERE "actor_type" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ALTER COLUMN "actor_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD COLUMN IF NOT EXISTS "actor_user_id" text;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD COLUMN IF NOT EXISTS "run_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD COLUMN IF NOT EXISTS "from_stage_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD COLUMN IF NOT EXISTS "to_stage_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD COLUMN IF NOT EXISTS "payload" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
UPDATE "pipeline_case_events"
SET "payload" = '{}'::jsonb
WHERE "payload" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ALTER COLUMN "payload" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
UPDATE "pipeline_case_events"
SET "created_at" = coalesce(
  "pipeline_case_events"."updated_at",
  "pipeline_cases"."updated_at",
  "pipeline_cases"."created_at",
  now()
)
FROM "pipeline_cases"
WHERE "pipeline_case_events"."case_id" = "pipeline_cases"."id"
  AND "pipeline_case_events"."created_at" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_case_events" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "lease_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_cases" ADD COLUMN IF NOT EXISTS "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "pipeline_documents" ADD COLUMN IF NOT EXISTS "key" text;--> statement-breakpoint
UPDATE "pipeline_documents"
SET "key" = "id"::text
WHERE "key" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_documents" ALTER COLUMN "key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_documents" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
UPDATE "pipeline_documents"
SET "updated_at" = now()
WHERE "updated_at" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_documents" ALTER COLUMN "updated_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN IF NOT EXISTS "key" text;--> statement-breakpoint
UPDATE "pipeline_stages"
SET "key" = "id"::text
WHERE "key" IS NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ALTER COLUMN "key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_stages" ADD COLUMN IF NOT EXISTS "position" integer DEFAULT 0;--> statement-breakpoint
WITH existing_stage_positions AS (
  SELECT "pipeline_id", max("position") AS "max_position"
  FROM "pipeline_stages"
  WHERE "position" IS NOT NULL
  GROUP BY "pipeline_id"
),
ranked_null_positions AS (
  SELECT
    "pipeline_stages"."id",
    coalesce(existing_stage_positions."max_position", -1) + row_number() OVER (
      PARTITION BY "pipeline_stages"."pipeline_id"
      ORDER BY "pipeline_stages"."created_at" NULLS LAST, "pipeline_stages"."name", "pipeline_stages"."id"
    ) AS "next_position"
  FROM "pipeline_stages"
  LEFT JOIN existing_stage_positions
    ON existing_stage_positions."pipeline_id" = "pipeline_stages"."pipeline_id"
  WHERE "position" IS NULL
)
UPDATE "pipeline_stages"
SET "position" = ranked_null_positions."next_position"
FROM ranked_null_positions
WHERE "pipeline_stages"."id" = ranked_null_positions."id";--> statement-breakpoint
ALTER TABLE "pipeline_stages" ALTER COLUMN "position" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_routine_id_routines_id_fk" FOREIGN KEY ("routine_id") REFERENCES "public"."routines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_automation_executions" ADD CONSTRAINT "pipeline_automation_executions_execution_issue_id_issues_id_fk" FOREIGN KEY ("execution_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_case_blockers" ADD CONSTRAINT "pipeline_case_blockers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_case_blockers" ADD CONSTRAINT "pipeline_case_blockers_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_case_blockers" ADD CONSTRAINT "pipeline_case_blockers_blocked_by_case_id_pipeline_cases_id_fk" FOREIGN KEY ("blocked_by_case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_actor_agent_id_agents_id_fk" FOREIGN KEY ("actor_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_from_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_case_events" ADD CONSTRAINT "pipeline_case_events_to_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_case_issue_links" ADD CONSTRAINT "pipeline_case_issue_links_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_case_issue_links" ADD CONSTRAINT "pipeline_case_issue_links_case_id_pipeline_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_case_issue_links" ADD CONSTRAINT "pipeline_case_issue_links_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_parent_case_id_pipeline_cases_id_fk" FOREIGN KEY ("parent_case_id") REFERENCES "public"."pipeline_cases"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_lease_agent_id_agents_id_fk" FOREIGN KEY ("lease_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_cases" ADD CONSTRAINT "pipeline_cases_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_documents" ADD CONSTRAINT "pipeline_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_documents" ADD CONSTRAINT "pipeline_documents_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_documents" ADD CONSTRAINT "pipeline_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_stages" ADD CONSTRAINT "pipeline_stages_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_transitions" ADD CONSTRAINT "pipeline_transitions_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_transitions" ADD CONSTRAINT "pipeline_transitions_from_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("from_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_transitions" ADD CONSTRAINT "pipeline_transitions_to_stage_id_pipeline_stages_id_fk" FOREIGN KEY ("to_stage_id") REFERENCES "public"."pipeline_stages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_automation_executions_idempotency_uq" ON "pipeline_automation_executions" USING btree ("case_id","automation_id","triggering_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_automation_executions_company_case_idx" ON "pipeline_automation_executions" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_automation_executions_routine_idx" ON "pipeline_automation_executions" USING btree ("routine_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_automation_executions_execution_issue_idx" ON "pipeline_automation_executions" USING btree ("execution_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_case_blockers_case_blocked_by_uq" ON "pipeline_case_blockers" USING btree ("case_id","blocked_by_case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_case_blockers_blocked_by_idx" ON "pipeline_case_blockers" USING btree ("blocked_by_case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_case_blockers_company_case_idx" ON "pipeline_case_blockers" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_case_events_case_created_idx" ON "pipeline_case_events" USING btree ("case_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_case_events_company_case_idx" ON "pipeline_case_events" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_case_issue_links_case_issue_uq" ON "pipeline_case_issue_links" USING btree ("case_id","issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_case_issue_links_issue_idx" ON "pipeline_case_issue_links" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_case_issue_links_company_case_idx" ON "pipeline_case_issue_links" USING btree ("company_id","case_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_cases_pipeline_case_key_uq" ON "pipeline_cases" USING btree ("pipeline_id","case_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_cases_company_idx" ON "pipeline_cases" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_cases_pipeline_stage_idx" ON "pipeline_cases" USING btree ("pipeline_id","stage_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_cases_parent_idx" ON "pipeline_cases" USING btree ("parent_case_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_cases_lease_expires_idx" ON "pipeline_cases" USING btree ("lease_expires_at") WHERE "pipeline_cases"."lease_expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_documents_company_pipeline_key_uq" ON "pipeline_documents" USING btree ("company_id","pipeline_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_documents_document_uq" ON "pipeline_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_documents_company_pipeline_updated_idx" ON "pipeline_documents" USING btree ("company_id","pipeline_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_stages_pipeline_key_uq" ON "pipeline_stages" USING btree ("pipeline_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_stages_pipeline_position_idx" ON "pipeline_stages" USING btree ("pipeline_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_transitions_pipeline_edge_uq" ON "pipeline_transitions" USING btree ("pipeline_id","from_stage_id","to_stage_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_transitions_pipeline_from_idx" ON "pipeline_transitions" USING btree ("pipeline_id","from_stage_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipeline_transitions_pipeline_to_idx" ON "pipeline_transitions" USING btree ("pipeline_id","to_stage_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "pipelines_company_key_uq" ON "pipelines" USING btree ("company_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipelines_company_idx" ON "pipelines" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "pipelines_company_project_idx" ON "pipelines" USING btree ("company_id","project_id");
