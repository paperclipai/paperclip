ALTER TABLE "chat_endpoints" DROP CONSTRAINT IF EXISTS "chat_endpoints_provider_check";--> statement-breakpoint
ALTER TABLE "chat_external_principals" DROP CONSTRAINT IF EXISTS "chat_external_principals_provider_check";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_publications_x_interaction_uq" ON "chat_publications" USING btree ("endpoint_id",("payload"->'xReply'->>'replyToPostId')) WHERE "chat_publications"."payload"->'xReply' is not null;--> statement-breakpoint
ALTER TABLE "chat_endpoints" DROP CONSTRAINT IF EXISTS "chat_endpoints_x_policy_check";--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_x_policy_check" CHECK ("chat_endpoints"."provider" <> 'x' or ("chat_endpoints"."publication_mode" = 'explicit' and "chat_endpoints"."external_execution_policy" = 'restricted' and "chat_endpoints"."allow_direct_messages" = false));--> statement-breakpoint
ALTER TABLE "chat_endpoints" ADD CONSTRAINT "chat_endpoints_provider_check" CHECK ("chat_endpoints"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail', 'imessage-photon', 'x'));--> statement-breakpoint
ALTER TABLE "chat_external_principals" ADD CONSTRAINT "chat_external_principals_provider_check" CHECK ("chat_external_principals"."provider" in ('slack', 'github', 'discord', 'microsoft-teams', 'telegram', 'agentmail', 'imessage-photon', 'x'));
