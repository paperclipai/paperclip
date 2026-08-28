CREATE TABLE "subscription_throttle_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"throttle_active" boolean DEFAULT false NOT NULL,
	"usage_percent" text DEFAULT '0' NOT NULL,
	"since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "subscription_throttle_state" ADD CONSTRAINT "subscription_throttle_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscription_throttle_state_company_provider_idx" ON "subscription_throttle_state" USING btree ("company_id","provider");