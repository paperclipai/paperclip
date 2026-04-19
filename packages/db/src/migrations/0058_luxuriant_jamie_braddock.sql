ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "last_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN IF NOT EXISTS "skip_issue_creation" boolean DEFAULT false NOT NULL;
