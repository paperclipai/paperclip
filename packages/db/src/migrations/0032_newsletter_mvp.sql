CREATE TABLE "newsletter_subscribers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "company_id" uuid NOT NULL,
  "email" text NOT NULL,
  "full_name" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "source" text DEFAULT 'landing_page' NOT NULL,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "last_checkout_mode" text,
  "last_checkout_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "unsubscribed_at" timestamp with time zone,
  "total_revenue_cents" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "newsletter_subscribers_company_id_companies_id_fk"
    FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX "newsletter_subscribers_company_created_idx" ON "newsletter_subscribers" USING btree ("company_id", "created_at");
--> statement-breakpoint
CREATE INDEX "newsletter_subscribers_company_status_idx" ON "newsletter_subscribers" USING btree ("company_id", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_subscribers_company_email_idx" ON "newsletter_subscribers" USING btree ("company_id", "email");
