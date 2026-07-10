ALTER TABLE "environment_custom_image_templates"
  ADD COLUMN IF NOT EXISTS "company_id" uuid;
--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions"
  ADD COLUMN IF NOT EXISTS "company_id" uuid;
--> statement-breakpoint
WITH "single_company" AS (
  SELECT "id"
  FROM "companies"
  WHERE (SELECT count(*) FROM "companies") = 1
)
UPDATE "environment_custom_image_templates" AS "templates"
SET "company_id" = "single_company"."id"
FROM "single_company"
WHERE "templates"."company_id" IS NULL;
--> statement-breakpoint
WITH "single_company" AS (
  SELECT "id"
  FROM "companies"
  WHERE (SELECT count(*) FROM "companies") = 1
)
UPDATE "environment_custom_image_setup_sessions" AS "sessions"
SET "company_id" = "single_company"."id"
FROM "single_company"
WHERE "sessions"."company_id" IS NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "environment_custom_image_templates"
    WHERE "company_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'environment_custom_image_templates contains rows without a resolvable company_id';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "environment_custom_image_setup_sessions"
    WHERE "company_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'environment_custom_image_setup_sessions contains rows without a resolvable company_id';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "environment_custom_image_templates"
  ALTER COLUMN "company_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "environment_custom_image_setup_sessions"
  ALTER COLUMN "company_id" SET NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'environment_custom_image_templates_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "environment_custom_image_templates"
      ADD CONSTRAINT "environment_custom_image_templates_company_id_companies_id_fk"
      FOREIGN KEY ("company_id")
      REFERENCES "public"."companies"("id")
      ON DELETE cascade
      ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "pg_constraint"
    WHERE "conname" = 'environment_custom_image_setup_sessions_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "environment_custom_image_setup_sessions"
      ADD CONSTRAINT "environment_custom_image_setup_sessions_company_id_companies_id_fk"
      FOREIGN KEY ("company_id")
      REFERENCES "public"."companies"("id")
      ON DELETE cascade
      ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_templates_company_environment_status_idx"
  ON "environment_custom_image_templates" USING btree ("company_id", "environment_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_templates_company_provider_status_idx"
  ON "environment_custom_image_templates" USING btree ("company_id", "provider", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environment_custom_image_templates_company_environment_active_uq"
  ON "environment_custom_image_templates" USING btree ("company_id", "environment_id")
  WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_templates_company_last_used_idx"
  ON "environment_custom_image_templates" USING btree ("company_id", "last_used_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_setup_sessions_company_environment_status_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "environment_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environment_custom_image_setup_sessions_company_environment_active_uq"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "environment_id")
  WHERE "status" IN ('starting', 'waiting_for_user', 'capturing');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_setup_sessions_company_template_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "template_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_setup_sessions_company_promoted_template_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "promoted_template_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environment_custom_image_setup_sessions_company_expires_idx"
  ON "environment_custom_image_setup_sessions" USING btree ("company_id", "expires_at");
