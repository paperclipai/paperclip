ALTER TABLE "tool_catalog_entries" ADD COLUMN "icons" jsonb;--> statement-breakpoint
ALTER TABLE "tool_mcp_app_views" ADD COLUMN "model_context" jsonb;--> statement-breakpoint
ALTER TABLE "tool_mcp_app_views" ADD COLUMN "model_context_updated_at" timestamp with time zone;