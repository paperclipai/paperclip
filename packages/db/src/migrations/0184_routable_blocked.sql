ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "unblock_descriptor" jsonb;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "blocked_transition_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "blocked_owner_notified_at" timestamp with time zone;
