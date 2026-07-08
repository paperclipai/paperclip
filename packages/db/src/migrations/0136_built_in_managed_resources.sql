CREATE TABLE "built_in_managed_resources" (
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

ALTER TABLE "built_in_managed_resources"
  ADD CONSTRAINT "built_in_managed_resources_company_id_companies_id_fk"
  FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "built_in_managed_resources_company_idx"
  ON "built_in_managed_resources" ("company_id");

CREATE INDEX "built_in_managed_resources_resource_idx"
  ON "built_in_managed_resources" ("resource_kind", "resource_id");

CREATE UNIQUE INDEX "built_in_managed_resources_company_bundle_resource_uq"
  ON "built_in_managed_resources" ("company_id", "bundle_key", "resource_kind", "resource_key");
