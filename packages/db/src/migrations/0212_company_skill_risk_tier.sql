ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "risk_tier" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "risk_tier_source" text DEFAULT 'unclassified' NOT NULL;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "risk_tier_rationale" jsonb;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "risk_tier_updated_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "risk_tier_updated_by_user_id" text;--> statement-breakpoint
ALTER TABLE "company_skills" ADD COLUMN IF NOT EXISTS "risk_tier_updated_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "company_skills" ADD CONSTRAINT "company_skills_risk_tier_updated_by_agent_id_agents_id_fk" FOREIGN KEY ("risk_tier_updated_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "company_skills_company_risk_tier_idx" ON "company_skills" USING btree ("company_id","risk_tier");
