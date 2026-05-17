-- Phase 4A-1 (LET-310): additive metadata columns for sandbox lease scaffolding.
-- Additive only: new nullable columns. No rename/drop/backfill required.
ALTER TABLE "environment_leases" ADD COLUMN IF NOT EXISTS "kind" text;
--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN IF NOT EXISTS "reason_code" text;
--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN IF NOT EXISTS "capabilities" jsonb;
--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN IF NOT EXISTS "quotas" jsonb;
--> statement-breakpoint
ALTER TABLE "environment_leases" ADD COLUMN IF NOT EXISTS "policy_hash" text;
