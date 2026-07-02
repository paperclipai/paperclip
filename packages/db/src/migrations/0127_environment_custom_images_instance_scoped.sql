WITH ranked_active_templates AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY environment_id
      ORDER BY captured_at DESC NULLS LAST, created_at DESC, id DESC
    ) AS kept_id,
    row_number() OVER (
      PARTITION BY environment_id
      ORDER BY captured_at DESC NULLS LAST, created_at DESC, id DESC
    ) AS rank
  FROM "environment_custom_image_templates"
  WHERE "status" = 'active'
)
UPDATE "environment_custom_image_templates" AS template
SET
  "status" = 'superseded',
  "superseded_by_template_id" = ranked_active_templates.kept_id,
  "updated_at" = now()
FROM ranked_active_templates
WHERE template.id = ranked_active_templates.id
  AND ranked_active_templates.rank > 1;
--> statement-breakpoint
WITH ranked_active_sessions AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY environment_id
      ORDER BY created_at DESC, id DESC
    ) AS rank
  FROM "environment_custom_image_setup_sessions"
  WHERE "status" IN ('starting', 'waiting_for_user', 'capturing')
)
UPDATE "environment_custom_image_setup_sessions" AS session
SET
  "status" = 'failed',
  "failure_reason" = 'Closed by migration to environment-scoped custom image sessions.',
  "finished_at" = COALESCE("finished_at", now()),
  "updated_at" = now()
FROM ranked_active_sessions
WHERE session.id = ranked_active_sessions.id
  AND ranked_active_sessions.rank > 1;
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_templates_company_environment_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_templates_company_provider_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_templates_company_environment_active_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_templates_company_last_used_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_environment_status_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_environment_active_uq";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_template_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_promoted_template_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environment_custom_image_setup_sessions_company_expires_idx";
--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates"
  DROP CONSTRAINT IF EXISTS "environment_custom_image_templates_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions"
  DROP CONSTRAINT IF EXISTS "environment_custom_image_setup_sessions_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates" DROP COLUMN IF EXISTS "company_id";
--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions" DROP COLUMN IF EXISTS "company_id";
--> statement-breakpoint
CREATE INDEX "environment_custom_image_templates_environment_status_idx"
  ON "environment_custom_image_templates" USING btree ("environment_id", "status");
--> statement-breakpoint
CREATE INDEX "environment_custom_image_templates_environment_provider_status_idx"
  ON "environment_custom_image_templates" USING btree ("environment_id", "provider", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "environment_custom_image_templates_environment_active_uq"
  ON "environment_custom_image_templates" USING btree ("environment_id")
  WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "environment_custom_image_templates_last_used_idx"
  ON "environment_custom_image_templates" USING btree ("last_used_at");
--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_environment_status_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("environment_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "environment_custom_image_setup_sessions_environment_active_uq"
  ON "environment_custom_image_setup_sessions" USING btree ("environment_id")
  WHERE "status" IN ('starting', 'waiting_for_user', 'capturing');
--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_template_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("template_id");
--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_promoted_template_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("promoted_template_id");
--> statement-breakpoint
CREATE INDEX "environment_custom_image_setup_sessions_expires_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("expires_at");
