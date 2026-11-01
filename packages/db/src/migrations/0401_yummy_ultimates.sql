CREATE INDEX CONCURRENTLY IF NOT EXISTS "chat_actions_github_terminal_work_idx" ON "chat_actions" USING btree ("id") WHERE "chat_actions"."kind" = 'github_response_comment'
      and "chat_actions"."status" = 'processed' and "chat_actions"."delivery_id" is not null
      and coalesce("chat_actions"."result"->>'final', 'false') <> 'true';
