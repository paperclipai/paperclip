CREATE TABLE IF NOT EXISTS "ai_connection_defaults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"method" text NOT NULL,
	"grant_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_connection_defaults_provider_check" CHECK ("ai_connection_defaults"."provider" in ('anthropic','openai','openrouter','xai')),
	CONSTRAINT "ai_connection_defaults_method_check" CHECK ("ai_connection_defaults"."method" in ('subscription','api_key'))
);
--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_transport_check";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_purpose_check";--> statement-breakpoint
ALTER TABLE "tool_connections" DROP CONSTRAINT IF EXISTS "tool_connections_channel_transport_check";--> statement-breakpoint
ALTER TABLE "adapter_auth_sessions" ADD COLUMN IF NOT EXISTS "ai_connection" jsonb;--> statement-breakpoint
ALTER TABLE "adapter_auth_sessions" ADD COLUMN IF NOT EXISTS "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "adapter_auth_sessions" ADD COLUMN IF NOT EXISTS "connection_grant_id" uuid;--> statement-breakpoint
ALTER TABLE "adapter_auth_sessions" ADD COLUMN IF NOT EXISTS "connection_method" text;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "ai_connection_defaults" ADD CONSTRAINT "ai_connection_defaults_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN ALTER TABLE "ai_connection_defaults" ADD CONSTRAINT "ai_connection_defaults_company_grant_fk" FOREIGN KEY ("company_id","grant_id") REFERENCES "public"."connection_grants"("company_id","id") ON DELETE no action ON UPDATE no action; EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_connection_defaults_owner_method_uq" ON "ai_connection_defaults" USING btree ("company_id","user_id","provider","method");--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_transport_check" CHECK ("tool_connections"."transport" in ('mcp_remote', 'rest_api', 'local_stdio', 'chat_sdk', 'runtime_auth'));--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_purpose_check" CHECK ("tool_connections"."connection_purpose" in ('tool', 'channel', 'ai'));--> statement-breakpoint
ALTER TABLE "tool_connections" ADD CONSTRAINT "tool_connections_channel_transport_check" CHECK ((
      ("tool_connections"."connection_purpose" = 'tool' and "tool_connections"."transport" not in ('chat_sdk', 'runtime_auth'))
      or
      ("tool_connections"."connection_purpose" = 'channel' and ("tool_connections"."transport" = 'chat_sdk' or ("tool_connections"."transport" = 'rest_api' and "tool_connections"."config"->>'provider' = 'agentmail')))
      or
      ("tool_connections"."connection_purpose" = 'ai' and "tool_connections"."transport" = 'runtime_auth')
    ));--> statement-breakpoint
-- Only declared per-user credentials have reliable ownership. Host auth homes
-- and company secrets are deliberately left untouched. No agent binding changes.
DO $$
DECLARE candidate record; application_id uuid; connection_id uuid; grant_id uuid;
BEGIN
  FOR candidate IN
    SELECT DISTINCT s.id AS secret_id, s.company_id, s.owner_user_id, s.user_secret_definition_id,
      s.name, s.created_at, a.id AS agent_id,
      CASE d.env_key WHEN 'ANTHROPIC_API_KEY' THEN 'anthropic' WHEN 'CLAUDE_CODE_OAUTH_TOKEN' THEN 'anthropic'
        WHEN 'OPENAI_API_KEY' THEN 'openai' WHEN 'OPENROUTER_API_KEY' THEN 'openrouter' WHEN 'XAI_API_KEY' THEN 'xai' END AS provider,
      CASE WHEN d.env_key = 'CLAUDE_CODE_OAUTH_TOKEN' THEN 'subscription' ELSE 'api_key' END AS method
    FROM company_secrets s
    JOIN user_secret_declarations d ON d.company_id = s.company_id AND d.user_secret_definition_id = s.user_secret_definition_id
    JOIN agents a ON a.company_id = s.company_id AND a.id::text = d.target_id AND d.target_type = 'agent'
    WHERE s.scope = 'user' AND s.owner_user_id IS NOT NULL AND s.status = 'active' AND s.deleted_at IS NULL
      AND ((a.adapter_type = 'claude_local' AND d.env_key IN ('ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'))
        OR (a.adapter_type = 'codex_local' AND d.env_key = 'OPENAI_API_KEY')
        OR (a.adapter_type = 'opencode_local' AND d.env_key = 'OPENROUTER_API_KEY')
        OR (a.adapter_type = 'grok_local' AND d.env_key = 'XAI_API_KEY'))
    ORDER BY s.created_at
  LOOP
    connection_id := overlay(overlay(md5('ai-connection:' || candidate.secret_id::text || ':' || candidate.provider || ':' || candidate.method) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid;
    grant_id := overlay(overlay(md5('ai-grant:' || connection_id::text) placing '5' from 13 for 1) placing '8' from 17 for 1)::uuid;
    INSERT INTO tool_applications(company_id,application_key,name,type,owner_user_id,metadata)
      VALUES(candidate.company_id,'app-gallery:' || candidate.provider,
        CASE candidate.provider WHEN 'anthropic' THEN 'Claude' WHEN 'openai' THEN 'OpenAI' WHEN 'openrouter' THEN 'OpenRouter' ELSE 'Grok' END,
        'mcp_http',candidate.owner_user_id,jsonb_build_object('sourceTemplateKey',candidate.provider)) ON CONFLICT DO NOTHING;
    SELECT id INTO application_id FROM tool_applications WHERE company_id = candidate.company_id
      AND (application_key = 'app-gallery:' || candidate.provider OR name = CASE candidate.provider WHEN 'anthropic' THEN 'Claude' WHEN 'openai' THEN 'OpenAI' WHEN 'openrouter' THEN 'OpenRouter' ELSE 'Grok' END) LIMIT 1;
    INSERT INTO tool_connections(id,company_id,application_id,name,uid,connection_purpose,transport,auth_kind,credential_policy,status,enabled,health_status,config,created_by_user_id)
      VALUES(connection_id,candidate.company_id,application_id,candidate.name,'ai-' || connection_id::text,'ai','runtime_auth',
        CASE WHEN candidate.method = 'subscription' THEN 'oauth' ELSE 'api_key' END,'per_user','active',true,'unknown',
        jsonb_build_object('sourceTemplateKey',candidate.provider,'ai',jsonb_build_object('provider',candidate.provider,'method',candidate.method),'aiLegacyAdoption',true),candidate.owner_user_id)
      ON CONFLICT DO NOTHING;
    INSERT INTO connection_grants(id,company_id,connection_id,kind,subject_user_id,credential_secret_refs,created_by_user_id)
      VALUES(grant_id,candidate.company_id,connection_id,'user',candidate.owner_user_id,
        jsonb_build_array(jsonb_build_object('secretId',candidate.secret_id,'configPath','ai.credential','required',true,'versionSelector','latest')),candidate.owner_user_id)
      ON CONFLICT DO NOTHING;
    INSERT INTO user_secret_declarations(company_id,user_secret_definition_id,target_type,target_id,config_path,env_key)
      VALUES(candidate.company_id,candidate.user_secret_definition_id,'tool_connection',connection_id::text,'ai.credential','ai.credential') ON CONFLICT DO NOTHING;
    INSERT INTO ai_connection_defaults(company_id,user_id,provider,method,grant_id)
      VALUES(candidate.company_id,candidate.owner_user_id,candidate.provider,candidate.method,grant_id) ON CONFLICT DO NOTHING;
    INSERT INTO tool_connection_installs(company_id,connection_id,target_type,target_id,created_by_user_id)
      VALUES(candidate.company_id,connection_id,'agent',candidate.agent_id::text,candidate.owner_user_id) ON CONFLICT DO NOTHING;
  END LOOP;
END $$;
