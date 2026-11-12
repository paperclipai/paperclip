ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "provider_type" text;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "application_key" text;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "upstream_tool_name" text;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "risk_level" text;
