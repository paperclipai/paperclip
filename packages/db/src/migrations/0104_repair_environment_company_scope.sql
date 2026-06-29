-- Repair older production databases where a pre-company-scoped `environments`
-- table already existed before 0065_environments.sql was recorded as applied.
-- Those databases have `environment_leases.company_id` but `environments` is still
-- global (`env_vars`, no `company_id`). The current runtime requires
-- per-company environments.

ALTER TABLE "environments" ADD COLUMN IF NOT EXISTS "company_id" uuid;
--> statement-breakpoint
DROP INDEX IF EXISTS "environments_local_driver_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environments_managed_sandbox_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environments_name_idx";
--> statement-breakpoint
DROP INDEX IF EXISTS "environments_status_idx";
--> statement-breakpoint
DO $$
DECLARE
  fallback_company_id uuid;
BEGIN
  SELECT id INTO fallback_company_id
  FROM companies
  ORDER BY created_at NULLS LAST, id
  LIMIT 1;

  IF fallback_company_id IS NULL AND EXISTS (SELECT 1 FROM environments WHERE company_id IS NULL) THEN
    RAISE EXCEPTION 'cannot repair environments.company_id without at least one company row';
  END IF;

  -- For each legacy environment row, keep the original row for one company so
  -- existing foreign keys remain valid during the repair.
  WITH legacy AS (
    SELECT e.id,
           COALESCE(
             (SELECT el.company_id
              FROM environment_leases el
              WHERE el.environment_id = e.id
              GROUP BY el.company_id
              ORDER BY count(*) DESC, el.company_id
              LIMIT 1),
             fallback_company_id
           ) AS company_id
    FROM environments e
    WHERE e.company_id IS NULL
  )
  UPDATE environments e
  SET company_id = legacy.company_id
  FROM legacy
  WHERE e.id = legacy.id;

  -- If a legacy environment had leases from multiple companies, create one
  -- matching environment per additional company.
  INSERT INTO environments (company_id, name, description, driver, status, config, metadata, created_at, updated_at)
  SELECT DISTINCT ON (el.company_id, e.driver)
         el.company_id,
         e.name,
         e.description,
         e.driver,
         e.status,
         e.config,
         e.metadata,
         e.created_at,
         now()
  FROM environment_leases el
  JOIN environments e ON e.id = el.environment_id
  WHERE e.company_id IS DISTINCT FROM el.company_id
    AND NOT EXISTS (
      SELECT 1
      FROM environments existing
      WHERE existing.company_id = el.company_id
        AND existing.driver = e.driver
    )
  ORDER BY el.company_id, e.driver, e.created_at, e.id;

  -- Rewire historical leases to the environment for their own company/driver.
  UPDATE environment_leases el
  SET environment_id = target.id,
      updated_at = now()
  FROM environments source, environments target
  WHERE source.id = el.environment_id
    AND target.company_id = el.company_id
    AND target.driver = source.driver
    AND source.company_id IS DISTINCT FROM el.company_id;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'environments_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "environments"
      ADD CONSTRAINT "environments_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "environments" ALTER COLUMN "company_id" SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environments_company_status_idx" ON "environments" USING btree ("company_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_driver_idx" ON "environments" USING btree ("company_id","driver") WHERE "driver" = 'local';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_company_managed_sandbox_idx" ON "environments" USING btree ("company_id") WHERE driver = 'sandbox' AND (metadata ->> 'managedByPaperclip')::boolean = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "environments_company_name_idx" ON "environments" USING btree ("company_id","name");
