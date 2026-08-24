-- paperclip:migration-safety-ignore create-table: Billing subscription tiers, customers, subscriptions, usage, and invoices tables. These were originally created in fork-only migrations 0137-0142 which were removed during upstream cleanup. The schema definitions persisted in packages/db/src/schema/; this migration creates the tables in the standard migration chain.

-- Subscription tiers (Adventurer, Explorer, Elite)
CREATE TABLE IF NOT EXISTS "subscription_tiers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name" text NOT NULL,
  "description" text,
  "price_monthly_cents" integer NOT NULL DEFAULT 0,
  "price_yearly_cents" integer NOT NULL DEFAULT 0,
  "stripe_price_monthly_id" text,
  "stripe_price_yearly_id" text,
  "stripe_product_id" text,
  "included_seats" integer NOT NULL DEFAULT 0,
  "extra_seat_price_cents" integer NOT NULL DEFAULT 0,
  "included_agent_runs" integer NOT NULL DEFAULT 0,
  "extra_agent_run_price_cents" integer NOT NULL DEFAULT 0,
  "included_storage_gb" integer NOT NULL DEFAULT 0,
  "extra_storage_gb_price_cents" integer NOT NULL DEFAULT 0,
  "features" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "is_active" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_tiers_name_idx" ON "subscription_tiers" USING btree ("name");

-- Stripe customers (one per company with Stripe integration)
CREATE TABLE IF NOT EXISTS "stripe_customers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "stripe_customer_id" text NOT NULL,
  "stripe_subscription_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "stripe_customers_company_idx" ON "stripe_customers" USING btree ("company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_customers_stripe_customer_idx" ON "stripe_customers" USING btree ("stripe_customer_id");

-- Company subscriptions (one per company, enforced by unique constraint)
CREATE TABLE IF NOT EXISTS "company_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "tier_id" uuid NOT NULL REFERENCES "subscription_tiers"("id"),
  "stripe_customer_id" uuid NOT NULL REFERENCES "stripe_customers"("id"),
  "status" text NOT NULL DEFAULT 'active',
  "billing_period" text NOT NULL DEFAULT 'monthly',
  "current_period_start" timestamp with time zone NOT NULL,
  "current_period_end" timestamp with time zone NOT NULL,
  "stripe_subscription_id" text,
  "stripe_subscription_item_id" text,
  "cancel_at_period_end" boolean NOT NULL DEFAULT false,
  "canceled_at" timestamp with time zone,
  "trial_end" timestamp with time zone,
  "metadata_json" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "company_subscriptions_company_idx" ON "company_subscriptions" USING btree ("company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "company_subscriptions_company_unique_idx" ON "company_subscriptions" USING btree ("company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "company_subscriptions_stripe_subscription_idx" ON "company_subscriptions" USING btree ("stripe_subscription_id");

-- Subscription usage records (per metric per period)
CREATE TABLE IF NOT EXISTS "subscription_usage" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "subscription_id" uuid NOT NULL REFERENCES "company_subscriptions"("id"),
  "metric" text NOT NULL,
  "usage" integer NOT NULL DEFAULT 0,
  "included" integer NOT NULL DEFAULT 0,
  "overage" integer NOT NULL DEFAULT 0,
  "overage_cents" integer NOT NULL DEFAULT 0,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "stripe_usage_record_id" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "subscription_usage_company_period_idx" ON "subscription_usage" USING btree ("company_id", "period_start", "period_end");
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_usage_sub_metric_period_idx" ON "subscription_usage" USING btree ("subscription_id", "metric", "period_start", "period_end");

-- Subscription invoices (synced from Stripe or created by webhook)
CREATE TABLE IF NOT EXISTS "subscription_invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "company_id" uuid NOT NULL REFERENCES "companies"("id"),
  "subscription_id" uuid NOT NULL REFERENCES "company_subscriptions"("id"),
  "stripe_invoice_id" text NOT NULL,
  "invoice_number" text,
  "status" text NOT NULL DEFAULT 'draft',
  "amount_cents" integer NOT NULL DEFAULT 0,
  "amount_paid_cents" integer NOT NULL DEFAULT 0,
  "amount_remaining_cents" integer NOT NULL DEFAULT 0,
  "currency" text NOT NULL DEFAULT 'usd',
  "invoice_pdf_url" text,
  "hosted_invoice_url" text,
  "period_start" timestamp with time zone,
  "period_end" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "subscription_invoices_company_idx" ON "subscription_invoices" USING btree ("company_id");
CREATE INDEX IF NOT EXISTS "subscription_invoices_stripe_invoice_idx" ON "subscription_invoices" USING btree ("stripe_invoice_id");
CREATE INDEX IF NOT EXISTS "subscription_invoices_subscription_idx" ON "subscription_invoices" USING btree ("subscription_id");