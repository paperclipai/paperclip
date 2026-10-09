CREATE TABLE IF NOT EXISTS "mcp_event_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subscription_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"reserves_subscription" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "mcp_event_admissions" ADD CONSTRAINT "mcp_event_admissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
ALTER TABLE "mcp_event_admissions" ADD CONSTRAINT "mcp_event_admissions_grant_id_mcp_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_event_admissions_expiry_idx" ON "mcp_event_admissions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_event_admissions_grant_idx" ON "mcp_event_admissions" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mcp_event_admissions_company_idx" ON "mcp_event_admissions" USING btree ("company_id");