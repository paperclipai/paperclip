CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_fallback_monitor_execution_uq" ON "issues" USING btree ("company_id", lower(regexp_replace(btrim("title"), '\\s+', ' ', 'g'))) WHERE "issues"."origin_kind" = 'routine_execution'
  and "issues"."hidden_at" is null
  and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked')
  and lower(regexp_replace(btrim("issues"."title"), '\\s+', ' ', 'g')) = 'fallback-monitor';
