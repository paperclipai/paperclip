ALTER TABLE "company_subscriptions" ADD COLUMN "trial_ends_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "company_subscriptions" ALTER COLUMN "plan_tier" SET DEFAULT 'trial';
--> statement-breakpoint
ALTER TABLE "company_subscriptions" ALTER COLUMN "status" SET DEFAULT 'trialing';
--> statement-breakpoint
UPDATE "company_subscriptions" SET "plan_tier" = 'trial', "status" = 'trialing', "trial_ends_at" = "created_at" + INTERVAL '14 days' WHERE "plan_tier" = 'free' AND "status" = 'free';
