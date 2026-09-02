CREATE TABLE IF NOT EXISTS "company_onboarding_seeds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"revision" text NOT NULL,
	"mission" text,
	"agent_name" text,
	"agent_role" text,
	"first_task_title" text,
	"first_task_details" text,
	"goal_id" uuid,
	"agent_id" uuid,
	"issue_id" uuid,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_onboarding_seeds_company_id_companies_id_fk' AND conrelid = 'company_onboarding_seeds'::regclass) THEN
		ALTER TABLE "company_onboarding_seeds" ADD CONSTRAINT "company_onboarding_seeds_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE cascade;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_onboarding_seeds_goal_id_goals_id_fk' AND conrelid = 'company_onboarding_seeds'::regclass) THEN
		ALTER TABLE "company_onboarding_seeds" ADD CONSTRAINT "company_onboarding_seeds_goal_id_goals_id_fk" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE set null;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_onboarding_seeds_agent_id_agents_id_fk' AND conrelid = 'company_onboarding_seeds'::regclass) THEN
		ALTER TABLE "company_onboarding_seeds" ADD CONSTRAINT "company_onboarding_seeds_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE set null;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_onboarding_seeds_issue_id_issues_id_fk' AND conrelid = 'company_onboarding_seeds'::regclass) THEN
		ALTER TABLE "company_onboarding_seeds" ADD CONSTRAINT "company_onboarding_seeds_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "issues"("id") ON DELETE set null;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_onboarding_seeds_company_uq" ON "company_onboarding_seeds" ("company_id");
