CREATE TABLE IF NOT EXISTS "plugin_database_namespaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"namespace_name" text NOT NULL,
	"namespace_mode" text DEFAULT 'schema' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "plugin_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"plugin_key" text NOT NULL,
	"namespace_name" text NOT NULL,
	"migration_key" text NOT NULL,
	"checksum" text NOT NULL,
	"plugin_version" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"error_message" text
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_database_namespaces_plugin_id_plugins_id_fk') THEN
  ALTER TABLE "plugin_database_namespaces" ADD CONSTRAINT "plugin_database_namespaces_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'plugin_migrations_plugin_id_plugins_id_fk') THEN
  ALTER TABLE "plugin_migrations" ADD CONSTRAINT "plugin_migrations_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_database_namespaces_plugin_idx" ON "plugin_database_namespaces" USING btree ("plugin_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_database_namespaces_namespace_idx" ON "plugin_database_namespaces" USING btree ("namespace_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_database_namespaces_status_idx" ON "plugin_database_namespaces" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "plugin_migrations_plugin_key_idx" ON "plugin_migrations" USING btree ("plugin_id","migration_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_migrations_plugin_idx" ON "plugin_migrations" USING btree ("plugin_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plugin_migrations_status_idx" ON "plugin_migrations" USING btree ("status");
