CREATE INDEX CONCURRENTLY IF NOT EXISTS "tool_gateway_sessions_expiry_idx" ON "tool_gateway_sessions" USING btree ("expires_at");
