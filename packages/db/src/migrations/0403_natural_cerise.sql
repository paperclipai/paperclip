CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_actions_github_stale_head_idx" ON "chat_actions" USING btree ("company_id","endpoint_id",("payload"->'event'->>'deliveryId')) WHERE "chat_actions"."kind" = 'github_review_check'
        and "chat_actions"."status" = 'cancelled' and "chat_actions"."result"->>'code' = 'stale_head';--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_github_reviews_projection_work_idx" ON "chat_github_reviews" USING btree ("id") WHERE "chat_github_reviews"."state" in ('queued', 'running')
      and "chat_github_reviews"."assessment" is null
      and "chat_github_reviews"."delivery_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';