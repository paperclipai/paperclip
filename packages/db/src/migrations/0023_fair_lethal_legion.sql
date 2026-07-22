ALTER TABLE "join_requests" ADD COLUMN "claim_secret_hash" text;--> statement-breakpoint
ALTER TABLE "join_requests" ADD COLUMN "claim_secret_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "join_requests" ADD COLUMN "claim_secret_consumed_at" timestamp with time zone;
