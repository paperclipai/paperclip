CREATE UNIQUE INDEX "chat_endpoints_live_discord_bot_external_uq" ON "chat_endpoints" USING btree ("provider","bot_external_id") WHERE "chat_endpoints"."provider" = 'discord'
          and "chat_endpoints"."status" in ('verifying', 'active', 'paused', 'attention')
          and "chat_endpoints"."bot_external_id" is not null;