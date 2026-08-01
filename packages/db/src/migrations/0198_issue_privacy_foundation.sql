ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'open' NOT NULL;
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "privacy_root_issue_id" uuid;

DO $$ BEGIN
  ALTER TABLE "issues"
    ADD CONSTRAINT "issues_visibility_check" CHECK ("visibility" IN ('open', 'private'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "issues"
    ADD CONSTRAINT "issues_privacy_root_issue_id_issues_id_fk"
    FOREIGN KEY ("privacy_root_issue_id") REFERENCES "public"."issues"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "issues_company_privacy_root_idx"
  ON "issues" USING btree ("company_id", "privacy_root_issue_id");

CREATE TABLE IF NOT EXISTS "issue_access_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "issue_id" uuid NOT NULL,
  "subject_type" text NOT NULL,
  "subject_id" text NOT NULL,
  "source" text NOT NULL,
  "granted_by_user_id" text,
  "granted_by_agent_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "revoked_at" timestamp with time zone,
  CONSTRAINT "issue_access_grants_subject_type_check" CHECK ("subject_type" IN ('user', 'agent')),
  CONSTRAINT "issue_access_grants_source_check" CHECK ("source" IN ('explicit', 'assignment', 'project'))
);

DO $$ BEGIN
  ALTER TABLE "issue_access_grants"
    ADD CONSTRAINT "issue_access_grants_issue_id_issues_id_fk"
    FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "issue_access_grants"
    ADD CONSTRAINT "issue_access_grants_granted_by_agent_id_agents_id_fk"
    FOREIGN KEY ("granted_by_agent_id") REFERENCES "public"."agents"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "issue_access_grants_subject_active_issue_idx"
  ON "issue_access_grants" USING btree ("subject_type", "subject_id", "revoked_at", "issue_id");
CREATE INDEX IF NOT EXISTS "issue_access_grants_issue_idx"
  ON "issue_access_grants" USING btree ("issue_id", "created_at");
