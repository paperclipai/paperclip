CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "routine_triggers_public_id_uq" ON "routine_triggers" USING btree ("public_id");
