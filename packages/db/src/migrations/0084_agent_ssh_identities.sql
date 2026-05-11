CREATE TABLE IF NOT EXISTS "agent_ssh_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"algorithm" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_ssh_identities_agent_id_agents_id_fk') THEN
		ALTER TABLE "agent_ssh_identities" ADD CONSTRAINT "agent_ssh_identities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_ssh_identities_company_id_companies_id_fk') THEN
		ALTER TABLE "agent_ssh_identities" ADD CONSTRAINT "agent_ssh_identities_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
	END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_ssh_identities_fingerprint_idx" ON "agent_ssh_identities" USING btree ("fingerprint");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_ssh_identities_agent_id_idx" ON "agent_ssh_identities" USING btree ("agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_ssh_identities_company_fingerprint_uq" ON "agent_ssh_identities" USING btree ("company_id","fingerprint");
