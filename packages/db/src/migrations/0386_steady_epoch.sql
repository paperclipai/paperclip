CREATE INDEX CONCURRENTLY IF NOT EXISTS "tool_action_requests_company_interaction_idx" ON "tool_action_requests" USING btree ("company_id","interaction_id");
