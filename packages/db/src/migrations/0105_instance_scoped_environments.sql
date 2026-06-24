ALTER TABLE "environments" ADD COLUMN "env_vars" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN "default_environment_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  CREATE TEMP TABLE environment_migration_map (
    old_id uuid PRIMARY KEY,
    new_id uuid NOT NULL
  ) ON COMMIT DROP;

  WITH ranked AS (
    SELECT
      e.id,
      CASE
        -- Only collapse classes that are globally singleton by design.
        -- Named remote environments may legitimately differ across companies
        -- even when they share the same display name.
        WHEN e.driver = 'local' THEN '__paperclip_builtin_local__'
        WHEN e.driver = 'sandbox' AND (e.metadata ->> 'managedByPaperclip')::boolean = true
          THEN '__paperclip_managed_sandbox__'
        ELSE e.id::text
      END AS group_key,
      row_number() OVER (
        PARTITION BY CASE
          WHEN e.driver = 'local' THEN '__paperclip_builtin_local__'
          WHEN e.driver = 'sandbox' AND (e.metadata ->> 'managedByPaperclip')::boolean = true
            THEN '__paperclip_managed_sandbox__'
          ELSE e.id::text
        END
        ORDER BY e.created_at ASC, e.id ASC
      ) AS rn
    FROM "environments" e
  ),
  canonical AS (
    SELECT
      ranked.group_key,
      ranked.id AS canonical_id
    FROM ranked
    WHERE ranked.rn = 1
  )
  INSERT INTO environment_migration_map (old_id, new_id)
  SELECT ranked.id, canonical.canonical_id
  FROM ranked
  JOIN canonical ON canonical.group_key = ranked.group_key;

  UPDATE "agents" AS agents
  SET "default_environment_id" = map.new_id
  FROM environment_migration_map AS map
  WHERE agents."default_environment_id" = map.old_id
    AND agents."default_environment_id" IS DISTINCT FROM map.new_id;

  UPDATE "environment_leases" AS leases
  SET "environment_id" = map.new_id
  FROM environment_migration_map AS map
  WHERE leases."environment_id" = map.old_id
    AND leases."environment_id" IS DISTINCT FROM map.new_id;

  DELETE FROM "environments" AS environments
  USING environment_migration_map AS map
  WHERE environments."id" = map.old_id
    AND map.old_id <> map.new_id;
END $$;
--> statement-breakpoint
UPDATE "issues"
SET "execution_workspace_settings" = "execution_workspace_settings" - 'environmentId'
WHERE jsonb_typeof("execution_workspace_settings") = 'object'
  AND "execution_workspace_settings" ? 'environmentId';
--> statement-breakpoint
DROP INDEX IF EXISTS "environments_company_managed_sandbox_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "environments_company_status_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "environments_company_driver_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "environments_company_name_idx";--> statement-breakpoint
ALTER TABLE "environments" DROP CONSTRAINT IF EXISTS "environments_company_id_companies_id_fk";--> statement-breakpoint
ALTER TABLE "environments" DROP COLUMN "company_id";--> statement-breakpoint
INSERT INTO "environments" (
  "id",
  "name",
  "description",
  "driver",
  "status",
  "config",
  "env_vars",
  "metadata",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  'Local',
  'Default execution environment for Paperclip runs on this machine.',
  'local',
  'active',
  '{}'::jsonb,
  '{}'::jsonb,
  '{"managedByPaperclip": true, "defaultForInstance": true}'::jsonb,
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1
  FROM "environments"
  WHERE "driver" = 'local'
);
--> statement-breakpoint
UPDATE "environments"
SET
  "metadata" = COALESCE("metadata", '{}'::jsonb) || '{"managedByPaperclip": true, "defaultForInstance": true}'::jsonb,
  "updated_at" = now()
WHERE "driver" = 'local';
--> statement-breakpoint
WITH duplicate_names AS (
  SELECT
    "id",
    "name",
    "driver",
    row_number() OVER (PARTITION BY "name" ORDER BY "created_at" ASC, "id" ASC) AS rn
  FROM "environments"
)
UPDATE "environments" AS environments
SET
  "name" = duplicate_names."name" || ' (' || duplicate_names."driver" || ' ' || substring(duplicate_names."id"::text from 1 for 8) || ')',
  "updated_at" = now()
FROM duplicate_names
WHERE environments."id" = duplicate_names."id"
  AND duplicate_names.rn > 1;
--> statement-breakpoint
INSERT INTO "instance_settings" (
  "id",
  "singleton_key",
  "default_environment_id",
  "general",
  "experimental",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  'default',
  local_env."id",
  '{}'::jsonb,
  '{}'::jsonb,
  now(),
  now()
FROM (
  SELECT "id"
  FROM "environments"
  WHERE "driver" = 'local'
  ORDER BY "created_at" ASC, "id" ASC
  LIMIT 1
) AS local_env
ON CONFLICT ("singleton_key") DO UPDATE
SET
  "default_environment_id" = EXCLUDED."default_environment_id",
  "updated_at" = now();
--> statement-breakpoint
ALTER TABLE "instance_settings"
  ADD CONSTRAINT "instance_settings_default_environment_id_environments_id_fk"
  FOREIGN KEY ("default_environment_id")
  REFERENCES "public"."environments"("id")
  ON DELETE set null
  ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "environments_status_idx" ON "environments" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "environments_local_driver_idx"
  ON "environments" USING btree ("driver")
  WHERE "driver" = 'local';
--> statement-breakpoint
CREATE UNIQUE INDEX "environments_managed_sandbox_idx"
  ON "environments" USING btree ("driver")
  WHERE "driver" = 'sandbox' AND ("metadata" ->> 'managedByPaperclip')::boolean = true;
--> statement-breakpoint
CREATE UNIQUE INDEX "environments_name_idx" ON "environments" USING btree ("name");
