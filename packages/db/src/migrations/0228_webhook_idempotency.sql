-- paperclip:migration-safety-ignore create-table: stripe_webhook_events dedup table
-- paperclip:migration-safety-ignore drop-index: subscription_invoices_stripe_invoice_idx (replaced by UNIQUE index)
-- paperclip:migration-safety-ignore drop-index: stripe_customers_company_idx (replaced by UNIQUE index)

-- Gap 1: Make stripe_invoice_id UNIQUE to prevent duplicate invoice rows
DROP INDEX IF EXISTS "subscription_invoices_stripe_invoice_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "subscription_invoices_stripe_invoice_idx" ON "subscription_invoices" USING btree ("stripe_invoice_id");

-- Gap 2: Make stripe_customers.company_id UNIQUE to prevent duplicate Stripe customers per company
DROP INDEX IF EXISTS "stripe_customers_company_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_customers_company_idx" ON "stripe_customers" USING btree ("company_id");

-- Gap 3: Stripe webhook events dedup table (UNIQUE stripe_event_id prevents re-processing)
CREATE TABLE IF NOT EXISTS "stripe_webhook_events" (
  "stripe_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "processed_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_webhook_events_event_id_idx" ON "stripe_webhook_events" USING btree ("stripe_event_id");