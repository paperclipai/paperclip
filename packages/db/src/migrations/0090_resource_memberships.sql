CREATE TABLE IF NOT EXISTS "agent_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'joined' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"state" text DEFAULT 'joined' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memberships_company_id_companies_id_fk') THEN
		ALTER TABLE "agent_memberships" ADD CONSTRAINT "agent_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_memberships_agent_id_agents_id_fk') THEN
		ALTER TABLE "agent_memberships" ADD CONSTRAINT "agent_memberships_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_memberships_company_id_companies_id_fk') THEN
		ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'project_memberships_project_id_projects_id_fk') THEN
		ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memberships_company_user_idx" ON "agent_memberships" USING btree ("company_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_memberships_agent_idx" ON "agent_memberships" USING btree ("agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_memberships_company_user_agent_uq" ON "agent_memberships" USING btree ("company_id","user_id","agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_memberships_company_user_idx" ON "project_memberships" USING btree ("company_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_memberships_project_idx" ON "project_memberships" USING btree ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_memberships_company_user_project_uq" ON "project_memberships" USING btree ("company_id","user_id","project_id");
