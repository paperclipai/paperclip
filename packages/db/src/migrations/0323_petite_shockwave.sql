ALTER TABLE "chat_github_registrations" ADD COLUMN IF NOT EXISTS "owner_type" text DEFAULT 'personal' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_github_registrations" ADD COLUMN IF NOT EXISTS "owner_login" text;--> statement-breakpoint
ALTER TABLE "chat_github_registrations" ADD COLUMN IF NOT EXISTS "app_name" text;--> statement-breakpoint
ALTER TABLE "chat_github_registrations" ADD COLUMN IF NOT EXISTS "handoff" jsonb;