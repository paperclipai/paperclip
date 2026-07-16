ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "archived_by_actor_type" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "archived_by_actor_id" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "archive_reason" text;--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "restore_manifest" jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "issues_company_archived_at_idx" ON "issues" USING btree ("company_id","archived_at");
