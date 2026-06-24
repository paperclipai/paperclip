CREATE TABLE IF NOT EXISTS "cloudflare_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "cf_account_id" text,
  "api_token_secret_id" uuid NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "verified_at" timestamp with time zone,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mail_domains" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "domain" text NOT NULL,
  "provider" text DEFAULT 'cloudflare' NOT NULL,
  "cf_zone_id" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "dkim_selector" text NOT NULL,
  "dkim_private_key_secret_id" uuid,
  "dkim_public_key" text,
  "mx_configured" boolean DEFAULT false NOT NULL,
  "spf_configured" boolean DEFAULT false NOT NULL,
  "dmarc_configured" boolean DEFAULT false NOT NULL,
  "last_error" text,
  "created_by_agent_id" uuid,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloudflare_connections" ADD CONSTRAINT "cloudflare_connections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cloudflare_connections" ADD CONSTRAINT "cloudflare_connections_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mail_domains" ADD CONSTRAINT "mail_domains_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cloudflare_connections_company_uq" ON "cloudflare_connections" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "mail_domains_company_domain_uq" ON "mail_domains" USING btree ("company_id","domain");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mail_domains_company_status_idx" ON "mail_domains" USING btree ("company_id","status");
