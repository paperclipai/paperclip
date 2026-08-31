ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "catalog_version_hash" text;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "catalog_schema_hash" text;--> statement-breakpoint
