ALTER TABLE "agents" ADD COLUMN "harness_verified_digest" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "harness_verified_at" timestamp with time zone;