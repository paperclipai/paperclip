CREATE TABLE IF NOT EXISTS "cross_company_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_company_id" uuid NOT NULL,
	"grantee_agent_id" uuid NOT NULL,
	"grantee_home_company_id" uuid NOT NULL,
	"actions" jsonb NOT NULL,
	"scope" jsonb,
	"budget_cap_cents" integer,
	"budget_spent_cents" integer DEFAULT 0 NOT NULL,
	"status" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"approval_id" uuid,
	"issued_by_user_id" text,
	"issued_by_agent_id" uuid,
	"signature" text,
	"signing_public_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_company_grants_target_company_id_companies_id_fk') THEN
		ALTER TABLE "cross_company_grants" ADD CONSTRAINT "cross_company_grants_target_company_id_companies_id_fk" FOREIGN KEY ("target_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_company_grants_grantee_agent_id_agents_id_fk') THEN
		ALTER TABLE "cross_company_grants" ADD CONSTRAINT "cross_company_grants_grantee_agent_id_agents_id_fk" FOREIGN KEY ("grantee_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_company_grants_grantee_home_company_id_companies_id_fk') THEN
		ALTER TABLE "cross_company_grants" ADD CONSTRAINT "cross_company_grants_grantee_home_company_id_companies_id_fk" FOREIGN KEY ("grantee_home_company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_company_grants_approval_id_approvals_id_fk') THEN
		ALTER TABLE "cross_company_grants" ADD CONSTRAINT "cross_company_grants_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cross_company_grants_issued_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "cross_company_grants" ADD CONSTRAINT "cross_company_grants_issued_by_agent_id_agents_id_fk" FOREIGN KEY ("issued_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cross_company_grants_grantee_target_idx" ON "cross_company_grants" USING btree ("target_company_id","grantee_agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cross_company_grants_grantee_lookup_idx" ON "cross_company_grants" USING btree ("grantee_agent_id","target_company_id","status");
