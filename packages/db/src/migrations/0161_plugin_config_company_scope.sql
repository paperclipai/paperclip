-- Scope plugin configuration rows by company before re-enabling plugin secret
-- refs. Legacy rows were instance-global; preserve only rows with an
-- unambiguous company owner and drop ambiguous rows fail-closed.

ALTER TABLE "plugin_config"
  ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint

WITH binding_owner AS (
  SELECT
    pc."id" AS config_id,
    min(csb."company_id"::text)::uuid AS company_id,
    count(DISTINCT csb."company_id") AS company_count
  FROM "plugin_config" pc
  JOIN "company_secret_bindings" csb
    ON csb."target_type" = 'plugin'
   AND csb."target_id" = pc."plugin_id"::text
  GROUP BY pc."id"
)
UPDATE "plugin_config" pc
SET "company_id" = bo."company_id"
FROM binding_owner bo
WHERE pc."company_id" IS NULL
  AND bo."config_id" = pc."id"
  AND bo."company_count" = 1;--> statement-breakpoint

WITH single_company AS (
  SELECT min("id"::text)::uuid AS company_id, count(*) AS company_count
  FROM "companies"
)
UPDATE "plugin_config" pc
SET "company_id" = sc."company_id"
FROM single_company sc
WHERE pc."company_id" IS NULL
  AND sc."company_count" = 1;--> statement-breakpoint

DELETE FROM "plugin_config"
WHERE "company_id" IS NULL;--> statement-breakpoint

ALTER TABLE "plugin_config"
  ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plugin_config_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "plugin_config"
      ADD CONSTRAINT "plugin_config_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DROP INDEX IF EXISTS "plugin_config_plugin_id_idx";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "plugin_config_plugin_company_idx"
  ON "plugin_config" USING btree ("plugin_id", "company_id");
