ALTER TABLE "provider_credentials" ADD COLUMN "quota_cooldown_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "quota_sampled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "quota_reason" text;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD COLUMN "last_failure_kind" text;
