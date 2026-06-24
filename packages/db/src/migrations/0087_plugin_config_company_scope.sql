ALTER TABLE "plugin_config" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
UPDATE "plugin_config"
SET "company_id" = (
  SELECT "id" FROM "companies" ORDER BY "created_at" ASC LIMIT 1
)
WHERE "company_id" IS NULL;--> statement-breakpoint
ALTER TABLE "plugin_config" ALTER COLUMN "company_id" SET NOT NULL;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_config_company_id_companies_id_fk') THEN
    ALTER TABLE "plugin_config" ADD CONSTRAINT "plugin_config_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "plugin_config_plugin_id_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_config_plugin_company_idx" ON "plugin_config" USING btree ("plugin_id", "company_id");
