ALTER TABLE "agent_api_keys" ADD COLUMN IF NOT EXISTS "scope_config" jsonb;
