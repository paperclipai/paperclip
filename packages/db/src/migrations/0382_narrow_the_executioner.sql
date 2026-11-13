CREATE INDEX CONCURRENTLY IF NOT EXISTS "tool_action_requests_pending_expiry_idx" ON "tool_action_requests" USING btree ("expires_at","id") WHERE "tool_action_requests"."status" = 'pending';
