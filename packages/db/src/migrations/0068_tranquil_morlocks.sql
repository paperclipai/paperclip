DROP INDEX "issues_open_routine_execution_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id","origin_fingerprint") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."execution_run_id" is not null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked', 'awaiting_human');