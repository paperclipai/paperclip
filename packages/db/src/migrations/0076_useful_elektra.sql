CREATE TABLE IF NOT EXISTS "plugin_managed_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_key" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"defaults_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "plugin_managed_resources" ADD CONSTRAINT "plugin_managed_resources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "plugin_managed_resources" ADD CONSTRAINT "plugin_managed_resources_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_managed_resources_company_idx" ON "plugin_managed_resources" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_managed_resources_plugin_idx" ON "plugin_managed_resources" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_managed_resources_resource_idx" ON "plugin_managed_resources" USING btree ("resource_kind","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_managed_resources_company_plugin_resource_uq" ON "plugin_managed_resources" USING btree ("company_id","plugin_id","resource_kind","resource_key");
