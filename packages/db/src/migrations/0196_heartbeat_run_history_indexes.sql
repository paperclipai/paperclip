-- paperclip:migration-safety-ignore large-create-index-not-concurrently: Drizzle migrations run transactionally, so CONCURRENTLY is unavailable; this covers recent heartbeat history when filtered by agent.
CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_agent_created_at_desc_idx"
  ON "heartbeat_runs" USING btree ("company_id", "agent_id", "created_at" DESC);
