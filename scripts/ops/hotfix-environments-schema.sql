-- Hotfix: create environments schema when migration 0065+ was never applied
-- but the server journal already reports up-to-date (common after fork deploy
-- on an older embedded Postgres volume).
--
-- Usage (inside Paperclip container or against instance Postgres):
--   psql "$DATABASE_URL" -f scripts/ops/hotfix-environments-schema.sql
--
-- Then restart Paperclip and retry chat wakeup.

CREATE TABLE IF NOT EXISTS "environments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "driver" text DEFAULT 'local' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "environment_leases" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "environment_id" uuid NOT NULL,
  "execution_workspace_id" uuid,
  "issue_id" uuid,
  "heartbeat_run_id" uuid,
  "status" text DEFAULT 'active' NOT NULL,
  "lease_policy" text DEFAULT 'ephemeral' NOT NULL,
  "provider" text,
  "provider_lease_id" text,
  "acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
  "expires_at" timestamp with time zone,
  "released_at" timestamp with time zone,
  "failure_reason" text,
  "cleanup_status" text,
  "metadata" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'environments_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "environments"
      ADD CONSTRAINT "environments_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "environments_company_status_idx"
  ON "environments" USING btree ("company_id","status");
CREATE INDEX IF NOT EXISTS "environments_company_name_idx"
  ON "environments" USING btree ("company_id","name");

DROP INDEX IF EXISTS "environments_company_driver_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_driver_idx"
  ON "environments" USING btree ("company_id","driver")
  WHERE "driver" = 'local';

ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "default_environment_id" uuid;
CREATE INDEX IF NOT EXISTS "agents_company_default_environment_idx"
  ON "agents" USING btree ("company_id","default_environment_id");

-- Seed default local environments for every company missing one.
INSERT INTO environments (company_id, name, description, driver, status, config, metadata, created_at, updated_at)
SELECT
  c.id,
  'Local',
  'Default execution environment for Paperclip runs on this machine.',
  'local',
  'active',
  '{}'::jsonb,
  '{"managedByPaperclip":true,"defaultForCompany":true}'::jsonb,
  NOW(),
  NOW()
FROM companies c
WHERE NOT EXISTS (
  SELECT 1 FROM environments e
  WHERE e.company_id = c.id AND e.driver = 'local'
);
