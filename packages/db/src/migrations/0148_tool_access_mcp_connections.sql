CREATE TABLE IF NOT EXISTS "tool_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "name" text NOT NULL,
  "type" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "application_id" uuid NOT NULL,
  "name" text NOT NULL,
  "transport" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "credential_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "health_status" text DEFAULT 'unchecked' NOT NULL,
  "health_message" text,
  "last_health_at" timestamp with time zone,
  "last_catalog_refresh_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_catalog_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "name" text NOT NULL,
  "title" text,
  "description" text,
  "input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "annotations" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "risk_level" text DEFAULT 'read' NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "version_hash" text NOT NULL,
  "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "quarantined_at" timestamp with time zone,
  "quarantine_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_runtime_slots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid NOT NULL,
  "slot_key" text NOT NULL,
  "status" text DEFAULT 'stopped' NOT NULL,
  "provider_ref" text,
  "health_status" text DEFAULT 'unchecked' NOT NULL,
  "health_message" text,
  "last_started_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "idle_deadline_at" timestamp with time zone,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "tool_access_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "connection_id" uuid,
  "catalog_entry_id" uuid,
  "actor_type" text DEFAULT 'system' NOT NULL,
  "actor_id" text,
  "action" text NOT NULL,
  "outcome" text NOT NULL,
  "reason_code" text,
  "details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_applications_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_applications" ADD CONSTRAINT "tool_applications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_connections_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_connections_application_id_tool_applications_id_fk') THEN
    ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_application_id_tool_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."tool_applications"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_catalog_entries_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_catalog_entries_connection_id_tool_connections_id_fk') THEN
    ALTER TABLE "tool_catalog_entries" ADD CONSTRAINT "tool_catalog_entries_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_slots_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_runtime_slots_connection_id_tool_connections_id_fk') THEN
    ALTER TABLE "tool_runtime_slots" ADD CONSTRAINT "tool_runtime_slots_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_access_audit_events_company_id_companies_id_fk') THEN
    ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_access_audit_events_connection_id_tool_connections_id_fk') THEN
    ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_connection_id_tool_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_access_audit_events_catalog_entry_id_tool_catalog_entries_id_fk') THEN
    ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_catalog_entry_id_tool_catalog_entries_id_fk" FOREIGN KEY ("catalog_entry_id") REFERENCES "public"."tool_catalog_entries"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tool_applications_company_idx" ON "tool_applications" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_applications_company_name_uq" ON "tool_applications" USING btree ("company_id", "name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_connections_company_idx" ON "tool_connections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_connections_application_idx" ON "tool_connections" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_connections_company_name_uq" ON "tool_connections" USING btree ("company_id", "name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_catalog_entries_company_idx" ON "tool_catalog_entries" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_catalog_entries_connection_idx" ON "tool_catalog_entries" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_catalog_entries_connection_name_uq" ON "tool_catalog_entries" USING btree ("connection_id", "name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_runtime_slots_company_idx" ON "tool_runtime_slots" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_runtime_slots_connection_idx" ON "tool_runtime_slots" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_runtime_slots_slot_key_uq" ON "tool_runtime_slots" USING btree ("company_id", "slot_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_access_audit_company_created_idx" ON "tool_access_audit_events" USING btree ("company_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_access_audit_connection_idx" ON "tool_access_audit_events" USING btree ("connection_id");
