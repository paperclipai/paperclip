-- paperclip:migration-compat online_compatible: the new table is created here; the transport check only widens (adds 'plugin'), is re-added NOT VALID so no table scan runs, and the previous release writes only values it already allowed.
CREATE TABLE "plugin_connector_legacy_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"connection_id" uuid,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT "tool_connections_transport_check";--> statement-breakpoint
ALTER TABLE "plugin_connector_legacy_access" ADD CONSTRAINT "plugin_connector_legacy_access_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_connector_legacy_access" ADD CONSTRAINT "plugin_connector_legacy_access_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_connector_legacy_access_company_plugin_uq" ON "plugin_connector_legacy_access" USING btree ("company_id","plugin_key");--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_transport_check" CHECK ("tool_connections"."transport" in ('mcp_remote', 'rest_api', 'local_stdio', 'chat_sdk', 'voice', 'runtime_auth', 'plugin')) NOT VALID;--> statement-breakpoint
-- Plugins installed now that declare legacy top-level tools keep them for
-- every agent: one row per plugin and company. The host turns each row into
-- one company-wide connection of the plugin's implicit connector.
INSERT INTO "plugin_connector_legacy_access" ("company_id", "plugin_key")
SELECT "companies"."id", "plugins"."plugin_key"
FROM "plugins" CROSS JOIN "companies"
WHERE "plugins"."status" <> 'uninstalled'
  AND jsonb_typeof("plugins"."manifest_json"->'tools') = 'array'
  AND jsonb_array_length("plugins"."manifest_json"->'tools') > 0
  AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof("plugins"."manifest_json"->'apps') = 'array' THEN "plugins"."manifest_json"->'apps' END), 0) = 0
ON CONFLICT DO NOTHING;