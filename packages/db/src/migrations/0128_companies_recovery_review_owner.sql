ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "recovery_review_owner_agent_id" uuid;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM "pg_constraint" WHERE "conname" = 'companies_recovery_review_owner_agent_id_agents_id_fk'
	) THEN
		ALTER TABLE "companies" ADD CONSTRAINT "companies_recovery_review_owner_agent_id_agents_id_fk" FOREIGN KEY ("recovery_review_owner_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
