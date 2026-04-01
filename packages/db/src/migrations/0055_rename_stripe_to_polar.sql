-- Rename Stripe columns to Polar (billing provider migration)
ALTER TABLE "company_subscriptions" RENAME COLUMN "stripe_customer_id" TO "polar_customer_id";
--> statement-breakpoint
ALTER TABLE "company_subscriptions" RENAME COLUMN "stripe_subscription_id" TO "polar_subscription_id";
