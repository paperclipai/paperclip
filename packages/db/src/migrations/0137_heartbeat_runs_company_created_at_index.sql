CREATE INDEX IF NOT EXISTS "heartbeat_runs_company_created_at_desc_idx"
  ON "heartbeat_runs" USING btree ("company_id", "created_at" DESC);
