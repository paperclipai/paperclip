ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "provision_job_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "provisioned_container_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "provision_error" text;--> statement-breakpoint
