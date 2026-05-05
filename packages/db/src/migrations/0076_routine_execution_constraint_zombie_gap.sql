-- Fix: zombie routine execution issues (open but executionRunId=null) were excluded
-- from the unique index because of the `execution_run_id IS NOT NULL` predicate.
-- When a heartbeat exits without completing an issue the heartbeat service clears
-- executionRunId, evicting the zombie from the index.  The next scheduled fire then
-- passes the skip_if_active check (findLiveExecutionIssue finds nothing) and creates
-- a second open execution issue.  Recovery is then blocked: checkout sets executionRunId
-- on the zombie, which conflicts with the new live issue already in the index.
--
-- Fix: drop the execution_run_id IS NOT NULL guard.  Zombie issues stay in the index
-- and correctly block duplicate creation regardless of their executionRunId state.
DROP INDEX IF EXISTS "issues_open_routine_execution_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "issues_open_routine_execution_uq" ON "issues" USING btree ("company_id","origin_kind","origin_id","origin_fingerprint") WHERE "issues"."origin_kind" = 'routine_execution'
          and "issues"."origin_id" is not null
          and "issues"."hidden_at" is null
          and "issues"."status" in ('backlog', 'todo', 'in_progress', 'in_review', 'blocked');
