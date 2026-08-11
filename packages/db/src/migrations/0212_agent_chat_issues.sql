CREATE UNIQUE INDEX IF NOT EXISTS "issues_active_agent_chat_uq"
  ON "issues" USING btree ("company_id","origin_kind","origin_id")
  WHERE "origin_kind" = 'agent_chat'
    AND "origin_id" IS NOT NULL
    AND "hidden_at" IS NULL;
