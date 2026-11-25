-- paperclip:migration-compat requires_staging: adding the validated recipient FK and index can lock company_skills; any later deployment requires separate authorization.
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "recipient_agent_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_recipient_company_fk"
    FOREIGN KEY ("company_id", "recipient_agent_id") REFERENCES "public"."agents"("company_id", "id")
    ON DELETE RESTRICT ON UPDATE NO ACTION;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skills_recipient_idx" ON "company_skills" USING btree ("company_id", "recipient_agent_id");
