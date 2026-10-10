ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "controller_boot_id" uuid;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "controller_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "execution_stage" text;