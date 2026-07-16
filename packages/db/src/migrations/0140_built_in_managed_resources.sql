CREATE TABLE IF NOT EXISTS "built_in_managed_resources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "bundle_key" text NOT NULL,
  "resource_kind" text NOT NULL,
  "resource_key" text NOT NULL,
  "resource_id" uuid NOT NULL,
  "stock_version" text NOT NULL,
  "stock_hash" text NOT NULL,
  "defaults_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "pg_constraint" c
    JOIN "pg_class" t ON t.oid = c.conrelid
    JOIN "pg_namespace" n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'built_in_managed_resources'
      AND c.conname = 'built_in_managed_resources_company_id_companies_id_fk'
  ) THEN
    ALTER TABLE "built_in_managed_resources"
      ADD CONSTRAINT "built_in_managed_resources_company_id_companies_id_fk"
      FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "built_in_managed_resources_company_idx"
  ON "built_in_managed_resources" ("company_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "built_in_managed_resources_resource_idx"
  ON "built_in_managed_resources" ("resource_kind", "resource_id");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "built_in_managed_resources_company_bundle_resource_uq"
  ON "built_in_managed_resources" ("company_id", "bundle_key", "resource_kind", "resource_key");
