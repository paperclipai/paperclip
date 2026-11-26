CREATE INDEX IF NOT EXISTS "tool_mcp_gateway_tokens_expiry_idx" ON "tool_mcp_gateway_tokens" USING btree ("expires_at","id");
