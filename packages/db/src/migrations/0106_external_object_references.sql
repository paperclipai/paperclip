CREATE TABLE IF NOT EXISTS "external_objects" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "provider_key" text NOT NULL,
  "plugin_id" uuid,
  "object_type" text NOT NULL,
  "external_id" text NOT NULL,
  "sanitized_canonical_url" text,
  "canonical_identity_hash" text,
  "display_title" text,
  "status_key" text,
  "status_label" text,
  "status_category" text DEFAULT 'unknown' NOT NULL,
  "status_tone" text DEFAULT 'neutral' NOT NULL,
  "liveness" text DEFAULT 'unknown' NOT NULL,
  "is_terminal" boolean DEFAULT false NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "remote_version" text,
  "etag" text,
  "last_resolved_at" timestamp with time zone,
  "last_changed_at" timestamp with time zone,
  "last_error_at" timestamp with time zone,
  "next_refresh_at" timestamp with time zone,
  "last_error_code" text,
  "last_error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "external_object_mentions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "source_issue_id" uuid NOT NULL,
  "source_kind" text NOT NULL,
  "source_record_id" uuid,
  "document_key" text,
  "property_key" text,
  "matched_text_redacted" text,
  "sanitized_display_url" text,
  "canonical_identity_hash" text,
  "canonical_identity" jsonb,
  "object_id" uuid,
  "provider_key" text,
  "detector_key" text,
  "object_type" text,
  "confidence" text DEFAULT 'exact' NOT NULL,
  "created_by_plugin_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_objects" ADD CONSTRAINT "external_objects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_objects" ADD CONSTRAINT "external_objects_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_object_mentions" ADD CONSTRAINT "external_object_mentions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_object_mentions" ADD CONSTRAINT "external_object_mentions_source_issue_id_issues_id_fk" FOREIGN KEY ("source_issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_object_mentions" ADD CONSTRAINT "external_object_mentions_object_id_external_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."external_objects"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "external_object_mentions" ADD CONSTRAINT "external_object_mentions_created_by_plugin_id_plugins_id_fk" FOREIGN KEY ("created_by_plugin_id") REFERENCES "public"."plugins"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_objects_company_provider_object_idx" ON "external_objects" USING btree ("company_id","provider_key","object_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_objects_company_provider_status_idx" ON "external_objects" USING btree ("company_id","provider_key","status_category");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_objects_company_refresh_idx" ON "external_objects" USING btree ("company_id","next_refresh_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_objects_company_external_id_uq" ON "external_objects" USING btree ("company_id","provider_key","object_type","external_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_objects_company_identity_uq" ON "external_objects" USING btree ("company_id","provider_key","object_type","canonical_identity_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_object_mentions_company_source_issue_idx" ON "external_object_mentions" USING btree ("company_id","source_issue_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_object_mentions_company_object_idx" ON "external_object_mentions" USING btree ("company_id","object_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_object_mentions_company_provider_idx" ON "external_object_mentions" USING btree ("company_id","provider_key","object_type");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_object_mentions_company_source_record_uq" ON "external_object_mentions" USING btree ("company_id","source_issue_id","source_kind","source_record_id","document_key","property_key","canonical_identity_hash") WHERE "source_record_id" is not null and "canonical_identity_hash" is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "external_object_mentions_company_source_null_record_uq" ON "external_object_mentions" USING btree ("company_id","source_issue_id","source_kind","document_key","property_key","canonical_identity_hash") WHERE "source_record_id" is null and "canonical_identity_hash" is not null;
