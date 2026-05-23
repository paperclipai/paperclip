CREATE TABLE IF NOT EXISTS "agent_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"requested_by_agent_id" uuid,
	"requested_by_user_id" text,
	"source_url" text NOT NULL,
	"source_type" text DEFAULT 'github' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"agents_found" integer DEFAULT 0 NOT NULL,
	"agents_created" integer DEFAULT 0 NOT NULL,
	"agents_failed" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_imports_company_id_companies_id_fk') THEN
		ALTER TABLE "agent_imports" ADD CONSTRAINT "agent_imports_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_imports_requested_by_agent_id_agents_id_fk') THEN
		ALTER TABLE "agent_imports" ADD CONSTRAINT "agent_imports_requested_by_agent_id_agents_id_fk" FOREIGN KEY ("requested_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_imports_company_id_idx" ON "agent_imports" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_imports_status_idx" ON "agent_imports" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_imports_created_at_idx" ON "agent_imports" USING btree ("created_at");