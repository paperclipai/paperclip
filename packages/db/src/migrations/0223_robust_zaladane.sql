ALTER TABLE "company_secret_proposals" ADD COLUMN IF NOT EXISTS "interaction_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_secret_proposals" ADD CONSTRAINT "company_secret_proposals_interaction_id_issue_thread_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."issue_thread_interactions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_secret_proposals_interaction_idx" ON "company_secret_proposals" USING btree ("interaction_id");
