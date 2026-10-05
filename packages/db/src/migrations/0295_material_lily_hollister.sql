CREATE UNIQUE INDEX "agent_api_keys_active_host_watcher_uq" ON "agent_api_keys" USING btree ("agent_id") WHERE "agent_api_keys"."revoked_at" is null and "agent_api_keys"."scope_config"->>'kind' = 'host_watcher';--> statement-breakpoint
CREATE UNIQUE INDEX "issues_open_host_watcher_order_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'host_watcher'
        and "issues"."origin_id" is not null
        and "issues"."hidden_at" is null
        and "issues"."status" not in ('done', 'cancelled');