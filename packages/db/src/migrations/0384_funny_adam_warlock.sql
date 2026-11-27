CREATE INDEX CONCURRENTLY IF NOT EXISTS "tool_action_requests_approved_idx" ON "tool_action_requests" USING btree ("id") WHERE "tool_action_requests"."status" = 'approved';
