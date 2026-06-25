ALTER TABLE "cross_company_agent_grants" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "cross_company_agent_grants" ADD COLUMN "max_uses" integer;--> statement-breakpoint
ALTER TABLE "cross_company_agent_grants" ADD COLUMN "used_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cross_company_agent_grants" ADD COLUMN "last_used_at" timestamp with time zone;
