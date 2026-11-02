CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_actions_github_ack_work_idx" ON "chat_actions" USING btree ("id") WHERE "chat_actions"."kind" = 'github_response_comment'
      and "chat_actions"."delivery_id" is not null and coalesce("chat_actions"."result"->>'final', 'false') <> 'true'
      and ("chat_actions"."status" = 'received' or ("chat_actions"."status" = 'failed' and "chat_actions"."result"->>'retryable' = 'true'));--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_publications_comment_destination_idx" ON "chat_publications" USING btree ("company_id","comment_id","endpoint_id","conversation_id") WHERE "chat_publications"."comment_id" is not null;--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "fast_response_requests_delivery_idx" ON "fast_response_requests" USING btree ("company_id","endpoint_id","delivery_id") WHERE "fast_response_requests"."delivery_id" is not null;
