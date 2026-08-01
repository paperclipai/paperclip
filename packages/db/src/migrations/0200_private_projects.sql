ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'open' NOT NULL;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "personal_owner_user_id" text;

DO $$ BEGIN
  ALTER TABLE "projects"
    ADD CONSTRAINT "projects_visibility_check" CHECK ("visibility" IN ('open', 'private'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "projects_company_personal_owner_uq"
  ON "projects" USING btree ("company_id", "personal_owner_user_id")
  WHERE "personal_owner_user_id" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "project_access_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "project_id" uuid NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "project_access_members_subject_type_check" CHECK ("subject_type" IN ('user', 'agent'))
);

DO $$ BEGIN
  ALTER TABLE "project_access_members"
    ADD CONSTRAINT "project_access_members_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "project_access_members"
    ADD CONSTRAINT "project_access_members_project_id_projects_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "project_access_members_project_subject_uq"
  ON "project_access_members" USING btree ("project_id", "subject_type", "subject_id");
CREATE INDEX IF NOT EXISTS "project_access_members_subject_lookup_idx"
  ON "project_access_members" USING btree ("company_id", "subject_type", "subject_id", "project_id");
