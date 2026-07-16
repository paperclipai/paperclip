DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "environment_custom_image_templates"
    WHERE "status" = 'active'
    GROUP BY "environment_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate environment custom image templates to environment scope while multiple active templates exist for the same environment. Revoke or supersede the extra active templates before retrying.';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "environment_custom_image_setup_sessions"
    WHERE "status" IN ('starting', 'waiting_for_user', 'capturing')
    GROUP BY "environment_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot migrate environment custom image setup sessions to environment scope while multiple active sessions exist for the same environment. Finish or cancel the extra sessions before retrying.';
  END IF;
END $$;
--> statement-breakpoint
UPDATE "environment_custom_image_templates"
SET
  "metadata" = jsonb_set(
    COALESCE("metadata", '{}'::jsonb),
    '{setupRpcCompanyId}',
    to_jsonb("company_id"::text),
    true
  ),
  "updated_at" = now()
WHERE "company_id" IS NOT NULL
  AND COALESCE("metadata" ->> 'setupRpcCompanyId', '') = '';
--> statement-breakpoint
UPDATE "environment_custom_image_setup_sessions"
SET
  "metadata" = jsonb_set(
    COALESCE("metadata", '{}'::jsonb),
    '{setupRpcCompanyId}',
    to_jsonb("company_id"::text),
    true
  ),
  "updated_at" = now()
WHERE "company_id" IS NOT NULL
  AND COALESCE("metadata" ->> 'setupRpcCompanyId', '') = '';
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
