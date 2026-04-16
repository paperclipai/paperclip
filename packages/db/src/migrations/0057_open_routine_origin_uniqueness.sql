CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_origin_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');
