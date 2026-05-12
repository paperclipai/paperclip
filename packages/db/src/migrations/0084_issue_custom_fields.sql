-- WS-4: First-class issue custom fields
-- Rollback:
--   DROP INDEX IF EXISTS "issue_custom_fields_text_sort_idx";
--   DROP INDEX IF EXISTS "issue_custom_fields_number_sort_idx";
--   DROP INDEX IF EXISTS "issue_custom_fields_plugin_idx";
--   DROP INDEX IF EXISTS "issue_custom_fields_issue_idx";
--   DROP INDEX IF EXISTS "issue_custom_fields_live_unique_idx";
--   DROP TABLE IF EXISTS "issue_custom_fields";

CREATE TABLE "issue_custom_fields" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "issue_id" uuid NOT NULL,
  "plugin_id" uuid NOT NULL,
  "field_key" text NOT NULL CHECK (
    char_length(field_key) <= 64
    AND field_key ~ '^[a-z][a-z0-9_-]*$'
  ),
  "field_type" text NOT NULL CHECK (
    field_type IN ('text', 'number', 'url', 'enum-ref')
  ),
  "field_label" text NOT NULL CHECK (char_length(field_label) <= 128),
  "value_text" varchar(4096),
  "value_number" numeric,
  "deleted_at" timestamp with time zone,
  "deleted_by_plugin_id" uuid,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "issue_custom_fields"
  ADD CONSTRAINT "issue_custom_fields_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE CASCADE ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_custom_fields"
  ADD CONSTRAINT "issue_custom_fields_issue_id_issues_id_fk"
  FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE CASCADE ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_custom_fields"
  ADD CONSTRAINT "issue_custom_fields_plugin_id_plugins_id_fk"
  FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE CASCADE ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "issue_custom_fields"
  ADD CONSTRAINT "issue_custom_fields_deleted_by_plugin_id_plugins_id_fk"
  FOREIGN KEY ("deleted_by_plugin_id") REFERENCES "public"."plugins"("id") ON DELETE SET NULL ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "issue_custom_fields_live_unique_idx"
  ON "issue_custom_fields" ("company_id", "issue_id", "plugin_id", "field_key")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "issue_custom_fields_issue_idx"
  ON "issue_custom_fields" ("company_id", "issue_id")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "issue_custom_fields_plugin_idx"
  ON "issue_custom_fields" ("plugin_id")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "issue_custom_fields_number_sort_idx"
  ON "issue_custom_fields" ("company_id", "plugin_id", "field_key", "value_number")
  WHERE "deleted_at" IS NULL AND "value_number" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "issue_custom_fields_text_sort_idx"
  ON "issue_custom_fields" ("company_id", "plugin_id", "field_key", "value_text")
  WHERE "deleted_at" IS NULL AND "value_text" IS NOT NULL;
