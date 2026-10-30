ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "source_trust" jsonb;--> statement-breakpoint
ALTER TABLE "issue_comments" ADD COLUMN IF NOT EXISTS "source_trust" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN IF NOT EXISTS "source_trust" jsonb;--> statement-breakpoint
ALTER TABLE "issue_work_products" ADD COLUMN IF NOT EXISTS "source_trust" jsonb;
