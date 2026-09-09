ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "manifest_source_hash" text;--> statement-breakpoint
ALTER TABLE "plugins" ADD COLUMN IF NOT EXISTS "pending_manifest_json" jsonb;