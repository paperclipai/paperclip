DROP INDEX "chat_message_links_provider_message_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "chat_endpoints_live_bot_external_uq" ON "chat_endpoints" USING btree ("provider","provider_account_id","bot_external_id") WHERE "chat_endpoints"."status" in ('verifying', 'active', 'paused', 'attention')
          and "chat_endpoints"."provider_account_id" is not null
          and "chat_endpoints"."bot_external_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_endpoints_live_bot_username_uq" ON "chat_endpoints" USING btree ("provider","provider_account_id","bot_username") WHERE "chat_endpoints"."status" in ('verifying', 'active', 'paused', 'attention')
          and "chat_endpoints"."provider_account_id" is not null
          and "chat_endpoints"."bot_username" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_links_provider_message_uq" ON "chat_message_links" USING btree ("endpoint_id","conversation_id","provider_message_id");