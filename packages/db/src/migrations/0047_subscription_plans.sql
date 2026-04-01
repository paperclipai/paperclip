CREATE TABLE IF NOT EXISTS "subscription_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid,
	"provider" text NOT NULL,
	"biller" text NOT NULL,
	"monthly_cost_cents" integer NOT NULL,
	"seat_count" integer DEFAULT 1 NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"effective_until" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "subscription_plans" ADD CONSTRAINT "subscription_plans_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_plans_company_active_idx" ON "subscription_plans" USING btree ("company_id","is_active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_plans_company_provider_idx" ON "subscription_plans" USING btree ("company_id","provider","biller");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscription_plans_company_agent_idx" ON "subscription_plans" USING btree ("company_id","agent_id");
--> statement-breakpoint
ALTER TABLE "cost_events" ADD COLUMN "amortized_cost_cents" integer;
