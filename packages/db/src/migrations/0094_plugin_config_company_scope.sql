ALTER TABLE "plugin_config" ADD COLUMN IF NOT EXISTS "company_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_config_company_id_companies_id_fk') THEN
		ALTER TABLE "plugin_config" ADD CONSTRAINT "plugin_config_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "plugin_config_plugin_id_idx";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_config_plugin_id_idx" ON "plugin_config" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_config_company_id_idx" ON "plugin_config" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_config_legacy_plugin_id_uq" ON "plugin_config" USING btree ("plugin_id") WHERE "plugin_config"."company_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_config_company_plugin_uq" ON "plugin_config" USING btree ("plugin_id","company_id") WHERE "plugin_config"."company_id" is not null;
