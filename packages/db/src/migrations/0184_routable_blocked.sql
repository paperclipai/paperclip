ALTER TABLE "issues" ADD COLUMN "unblock_descriptor" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "blocked_transition_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "blocked_owner_notified_at" timestamp with time zone;
