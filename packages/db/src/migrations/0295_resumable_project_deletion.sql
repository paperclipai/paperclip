ALTER TABLE "projects" ADD COLUMN "deletion_claim_token" text;
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "deletion_claim_expires_at" timestamp with time zone;
