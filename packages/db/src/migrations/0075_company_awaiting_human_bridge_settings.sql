CREATE TABLE "company_awaiting_human_settings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT false NOT NULL,
  "provider" text,
  "provider_config_json" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "company_awaiting_human_settings_company_uq"
ON "company_awaiting_human_settings" ("company_id");
