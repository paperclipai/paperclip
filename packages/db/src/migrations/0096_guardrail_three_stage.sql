ALTER TABLE "budget_policies" ADD COLUMN IF NOT EXISTS "warn_high_percent" integer DEFAULT 85 NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN IF NOT EXISTS "warn_recovery_percent" integer DEFAULT 55 NOT NULL;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD COLUMN IF NOT EXISTS "warn_high_recovery_percent" integer DEFAULT 75 NOT NULL;
