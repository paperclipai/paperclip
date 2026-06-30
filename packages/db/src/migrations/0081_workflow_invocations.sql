ALTER TABLE "workflows" ADD COLUMN "workflow_key" text;
ALTER TABLE "workflows" ADD COLUMN "capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;

WITH ranked_workflows AS (
  SELECT
    "id",
    "company_id",
    COALESCE(
      NULLIF(btrim(regexp_replace(lower("title"), '[^a-z0-9]+', '-', 'g'), '-'), ''),
      'workflow-' || substr(replace("id"::text, '-', ''), 1, 8)
    ) AS "base_key",
    row_number() OVER (
      PARTITION BY "company_id", COALESCE(
        NULLIF(btrim(regexp_replace(lower("title"), '[^a-z0-9]+', '-', 'g'), '-'), ''),
        'workflow-' || substr(replace("id"::text, '-', ''), 1, 8)
      )
      ORDER BY "created_at", "id"
    ) AS "rn"
  FROM "workflows"
)
UPDATE "workflows" AS w
SET "workflow_key" = CASE
  WHEN ranked_workflows."rn" = 1 THEN ranked_workflows."base_key"
  ELSE ranked_workflows."base_key" || '-' || ranked_workflows."rn"::text
END
FROM ranked_workflows
WHERE w."id" = ranked_workflows."id";

CREATE UNIQUE INDEX "workflows_company_workflow_key_uq" ON "workflows" ("company_id","workflow_key");
CREATE INDEX "workflows_capabilities_idx" ON "workflows" USING gin ("capabilities");

CREATE TABLE "workflow_invocations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE cascade,
  "source_routine_id" uuid NOT NULL REFERENCES "routines"("id") ON DELETE cascade,
  "source_routine_run_id" uuid NOT NULL REFERENCES "routine_runs"("id") ON DELETE cascade,
  "target_workflow_id" uuid NOT NULL REFERENCES "workflows"("id") ON DELETE cascade,
  "target_workflow_key" text,
  "target_capability" text,
  "contract_version" text NOT NULL,
  "input_kind" text NOT NULL,
  "input_markdown" text NOT NULL,
  "input_json" jsonb,
  "workflow_run_id" uuid REFERENCES "workflow_runs"("id") ON DELETE cascade,
  "status" text DEFAULT 'queued' NOT NULL,
  "failure_reason" text,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "workflow_invocations_company_created_idx" ON "workflow_invocations" ("company_id","created_at");
CREATE INDEX "workflow_invocations_source_routine_run_idx" ON "workflow_invocations" ("source_routine_run_id","created_at");
CREATE INDEX "workflow_invocations_target_workflow_idx" ON "workflow_invocations" ("target_workflow_id","created_at");
CREATE UNIQUE INDEX "workflow_invocations_workflow_run_uq" ON "workflow_invocations" ("workflow_run_id");
