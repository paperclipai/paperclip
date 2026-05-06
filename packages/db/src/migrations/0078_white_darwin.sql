ALTER TABLE "issue_comments" ADD COLUMN "author_type" text;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "presentation" jsonb;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN "metadata" jsonb;