ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "gateway_public_id" text;
--> statement-breakpoint
UPDATE "tool_mcp_gateways"
SET "gateway_public_id" = 'gw_' || replace("id"::text, '-', '')
WHERE "gateway_public_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ALTER COLUMN "gateway_public_id" SET DEFAULT ('gw_' || replace(gen_random_uuid()::text, '-', ''));
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ALTER COLUMN "gateway_public_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "display_slug" text;
--> statement-breakpoint
UPDATE "tool_mcp_gateways"
SET "display_slug" = "slug"
WHERE "display_slug" IS NULL OR "display_slug" = '';
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ALTER COLUMN "display_slug" SET DEFAULT '';
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ALTER COLUMN "display_slug" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "default_profile_mode" text DEFAULT 'gateway_only' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "context_scope_type" text DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "context_scope_id" text;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "approval_issue_id" uuid;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "auth_config" jsonb DEFAULT '{"version":1,"bearer":{"enabled":true,"tokenPrefix":"pcgw","defaultTtlSeconds":7776000,"requireFiniteExpiry":true,"longLivedTokenRequiresOverride":true},"oauth":{"enabled":false,"reservedFor":"v1_5","dynamicClientRegistration":false,"authorizationCodePkce":false}}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "header_policy" jsonb DEFAULT '{"version":1,"callerPassthrough":{"enabled":false,"allowedHeaders":[]},"staticHeaders":[],"generatedMetadata":{"enabled":false,"allowedHeaders":[]},"responseHeaders":{"forwardMcpRequiredHeaders":true,"forwardSafeCacheHeaders":true}}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "metadata_policy" jsonb DEFAULT '{"version":1,"forwardCompanyId":false,"forwardGatewayId":false,"forwardProjectId":false,"forwardIssueId":false,"forwardAgentId":false,"forwardRunId":false,"forwardCorrelationId":true}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "on_demand_tools_config" jsonb DEFAULT '{"enabled":false,"searchToolName":"search_tools","runToolName":"run_tool"}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateways" ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "token_prefix" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "subject_type" text DEFAULT 'gateway_client' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "subject_id" text;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "client_label" text DEFAULT '' NOT NULL;
--> statement-breakpoint
UPDATE "tool_mcp_gateway_tokens"
SET "client_label" = "name"
WHERE "client_label" = '';
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "owner_note" text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "allowed_actions" jsonb DEFAULT '["tools/list","tools/call"]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "expiry_override_reason" text;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "expiry_override_by_user_id" text;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "expiry_override_by_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "tool_mcp_gateway_tokens" ADD COLUMN IF NOT EXISTS "expiry_override_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "gateway_id" uuid;
--> statement-breakpoint
ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "gateway_token_id" uuid;
--> statement-breakpoint
ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "gateway_public_id" text;
--> statement-breakpoint
ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "client_subject_type" text;
--> statement-breakpoint
ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "client_subject_id" text;
--> statement-breakpoint
ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "client_name" text;
--> statement-breakpoint
ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "mcp_session_id" text;
--> statement-breakpoint
ALTER TABLE "tool_gateway_sessions" ADD COLUMN IF NOT EXISTS "correlation_id" text;
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "gateway_id" uuid;
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "gateway_token_id" uuid;
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "gateway_public_id" text;
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "client_subject_type" text;
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "client_subject_id" text;
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "client_name" text;
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "mcp_session_id" text;
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "correlation_id" text;
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "policy_explanation" jsonb;
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "credential_scope_summary" jsonb;
--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN IF NOT EXISTS "header_policy_summary" jsonb;
--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "gateway_id" uuid;
--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "gateway_token_id" uuid;
--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "gateway_public_id" text;
--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "client_subject_type" text;
--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "client_subject_id" text;
--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "client_name" text;
--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "mcp_session_id" text;
--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "correlation_id" text;
--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "policy_explanation" jsonb;
--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "credential_scope_summary" jsonb;
--> statement-breakpoint
ALTER TABLE "tool_call_events" ADD COLUMN IF NOT EXISTS "header_policy_summary" jsonb;
--> statement-breakpoint
ALTER TABLE "tool_access_audit_events" ADD COLUMN IF NOT EXISTS "gateway_id" uuid;
--> statement-breakpoint
ALTER TABLE "tool_access_audit_events" ADD COLUMN IF NOT EXISTS "gateway_token_id" uuid;
--> statement-breakpoint
ALTER TABLE "tool_access_audit_events" ADD COLUMN IF NOT EXISTS "gateway_public_id" text;
--> statement-breakpoint
ALTER TABLE "tool_access_audit_events" ADD COLUMN IF NOT EXISTS "client_name" text;
--> statement-breakpoint
ALTER TABLE "tool_access_audit_events" ADD COLUMN IF NOT EXISTS "correlation_id" text;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_mcp_gateways_approval_issue_id_issues_id_fk') THEN
    ALTER TABLE "tool_mcp_gateways" ADD CONSTRAINT "tool_mcp_gateways_approval_issue_id_issues_id_fk" FOREIGN KEY ("approval_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_mcp_gateway_tokens_expiry_override_by_agent_id_agents_id_fk') THEN
    ALTER TABLE "tool_mcp_gateway_tokens" ADD CONSTRAINT "tool_mcp_gateway_tokens_expiry_override_by_agent_id_agents_id_fk" FOREIGN KEY ("expiry_override_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_gateway_id_tool_mcp_gateways_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_gateway_sessions_gateway_token_id_tool_mcp_gateway_tokens_id_fk') THEN
    ALTER TABLE "tool_gateway_sessions" ADD CONSTRAINT "tool_gateway_sessions_gateway_token_id_tool_mcp_gateway_tokens_id_fk" FOREIGN KEY ("gateway_token_id") REFERENCES "public"."tool_mcp_gateway_tokens"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_gateway_id_tool_mcp_gateways_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_invocations_gateway_token_id_tool_mcp_gateway_tokens_id_fk') THEN
    ALTER TABLE "tool_invocations" ADD CONSTRAINT "tool_invocations_gateway_token_id_tool_mcp_gateway_tokens_id_fk" FOREIGN KEY ("gateway_token_id") REFERENCES "public"."tool_mcp_gateway_tokens"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_gateway_id_tool_mcp_gateways_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_call_events_gateway_token_id_tool_mcp_gateway_tokens_id_fk') THEN
    ALTER TABLE "tool_call_events" ADD CONSTRAINT "tool_call_events_gateway_token_id_tool_mcp_gateway_tokens_id_fk" FOREIGN KEY ("gateway_token_id") REFERENCES "public"."tool_mcp_gateway_tokens"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_access_audit_events_gateway_id_tool_mcp_gateways_id_fk') THEN
    ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_gateway_id_tool_mcp_gateways_id_fk" FOREIGN KEY ("gateway_id") REFERENCES "public"."tool_mcp_gateways"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tool_access_audit_events_gateway_token_id_tool_mcp_gateway_tokens_id_fk') THEN
    ALTER TABLE "tool_access_audit_events" ADD CONSTRAINT "tool_access_audit_events_gateway_token_id_tool_mcp_gateway_tokens_id_fk" FOREIGN KEY ("gateway_token_id") REFERENCES "public"."tool_mcp_gateway_tokens"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tool_mcp_gateways_public_id_uq" ON "tool_mcp_gateways" USING btree ("gateway_public_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_mcp_gateway_tokens_subject_idx" ON "tool_mcp_gateway_tokens" USING btree ("company_id", "subject_type", "subject_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_gateway_sessions_gateway_idx" ON "tool_gateway_sessions" USING btree ("company_id", "gateway_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_invocations_gateway_idx" ON "tool_invocations" USING btree ("company_id", "gateway_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_call_events_gateway_idx" ON "tool_call_events" USING btree ("company_id", "gateway_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tool_access_audit_gateway_idx" ON "tool_access_audit_events" USING btree ("company_id", "gateway_id");
