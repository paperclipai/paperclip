ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "author_type" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "presentation" jsonb;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "metadata" jsonb;
