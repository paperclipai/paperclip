-- Reentrant for instances that applied the earlier experimental migration number.
ALTER TABLE "remote_agent_profiles" DROP CONSTRAINT IF EXISTS "remote_agent_profiles_service_check";--> statement-breakpoint
ALTER TABLE "remote_agent_profiles" ADD COLUMN IF NOT EXISTS "credential_secret_id" uuid;--> statement-breakpoint
ALTER TABLE "remote_agent_profiles" DROP CONSTRAINT IF EXISTS "remote_agent_profiles_credential_secret_id_company_secrets_id_fk";--> statement-breakpoint
ALTER TABLE "remote_agent_profiles" ADD CONSTRAINT "remote_agent_profiles_credential_secret_id_company_secrets_id_fk" FOREIGN KEY ("credential_secret_id") REFERENCES "public"."company_secrets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "remote_agent_profiles" DROP CONSTRAINT IF EXISTS "remote_agent_profiles_credential_service_check";--> statement-breakpoint
ALTER TABLE "remote_agent_profiles" ADD CONSTRAINT "remote_agent_profiles_credential_service_check" CHECK (("remote_agent_profiles"."service" = 'aws_bedrock_agentcore_harness' AND "remote_agent_profiles"."credential_secret_id" IS NULL) OR ("remote_agent_profiles"."service" = 'openai_agents_api' AND "remote_agent_profiles"."credential_secret_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "remote_agent_profiles" ADD CONSTRAINT "remote_agent_profiles_service_check" CHECK ("remote_agent_profiles"."service" IN ('aws_bedrock_agentcore_harness', 'openai_agents_api'));
