CREATE TABLE IF NOT EXISTS "company_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "polar_customer_id" text,
  "polar_subscription_id" text,
  "plan_tier" text DEFAULT 'free' NOT NULL,
  "status" text DEFAULT 'free' NOT NULL,
  "current_period_start" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "cancel_at_period_end" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "company_subscriptions_company_idx" ON "company_subscriptions" USING btree ("company_id");
