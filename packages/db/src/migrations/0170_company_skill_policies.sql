CREATE TABLE IF NOT EXISTS "company_skill_policies" (
  "company_id" uuid PRIMARY KEY NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "schema_version" integer DEFAULT 1 NOT NULL,
  "revision" integer NOT NULL,
  "default_effect" text NOT NULL,
  "rules" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "company_skill_policies_schema_version_check" CHECK ("schema_version" = 1),
  CONSTRAINT "company_skill_policies_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "company_skill_policies_default_effect_check" CHECK ("default_effect" IN ('allow', 'deny'))
);
