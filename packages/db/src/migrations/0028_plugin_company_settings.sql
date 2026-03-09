CREATE TABLE "plugin_company_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"settings_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plugin_company_settings" ADD CONSTRAINT "plugin_company_settings_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plugin_company_settings" ADD CONSTRAINT "plugin_company_settings_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "plugin_company_settings_company_idx" ON "plugin_company_settings" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "plugin_company_settings_plugin_idx" ON "plugin_company_settings" USING btree ("plugin_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_company_settings_company_plugin_uq" ON "plugin_company_settings" USING btree ("company_id","plugin_id");
