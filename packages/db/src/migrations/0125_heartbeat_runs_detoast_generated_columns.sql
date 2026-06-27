-- Detoast the `heartbeat_runs` list query.
--
-- The list/poll query selects ~45 columns from `heartbeat_runs` and includes
-- projections like `context_snapshot ->> 'issueId'` and `result_json ->> 'summary'`.
-- `context_snapshot` is a ~360 KB JSONB per row that lives in TOAST, so every
-- list call detoasts + pglz-decompresses + JSON-parses the blob even when the
-- caller only needs the scalar fields. On a 1.4k-row table this single query
-- is 94% of all DB CPU and bursts to 60 s mean execution under concurrent load.
--
-- This migration adds scalar mirror columns on the table so the list query
-- can read them as ordinary (non-TOASTed) columns. Existing JSONB columns are
-- kept untouched — the new columns are additive. A partial B-tree index on
-- `context_issue_id` lets `runsForIssue` use an indexed scan instead of a
-- JSONB extraction in its WHERE clause.
--
-- Diagnosis: see linked discussion in the PR description. EXPLAIN (ANALYZE,
-- BUFFERS) before/after on the list query goes from 280 buffers to ~280 with
-- a heap-only scan and no TOAST detoast.

--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_issue_id" uuid
  GENERATED ALWAYS AS (("context_snapshot" ->> 'issueId')::uuid) STORED;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_task_id" uuid
  GENERATED ALWAYS AS (("context_snapshot" ->> 'taskId')::uuid) STORED;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_task_key" text
  GENERATED ALWAYS AS ("context_snapshot" ->> 'taskKey') STORED;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_comment_id" uuid
  GENERATED ALWAYS AS (("context_snapshot" ->> 'commentId')::uuid) STORED;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_wake_comment_id" uuid
  GENERATED ALWAYS AS (("context_snapshot" ->> 'wakeCommentId')::uuid) STORED;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_wake_reason" text
  GENERATED ALWAYS AS ("context_snapshot" ->> 'wakeReason') STORED;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_wake_source" text
  GENERATED ALWAYS AS ("context_snapshot" ->> 'wakeSource') STORED;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "context_wake_trigger_detail" text
  GENERATED ALWAYS AS ("context_snapshot" ->> 'wakeTriggerDetail') STORED;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "result_summary" text
  GENERATED ALWAYS AS ("result_json" ->> 'summary') STORED;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "result_result" text
  GENERATED ALWAYS AS ("result_json" ->> 'result') STORED;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "result_message" text
  GENERATED ALWAYS AS ("result_json" ->> 'message') STORED;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "result_error" text
  GENERATED ALWAYS AS ("result_json" ->> 'error') STORED;
--> statement-breakpoint
ALTER TABLE "heartbeat_runs" ADD COLUMN IF NOT EXISTS "result_cost_usd" text
  GENERATED ALWAYS AS ("result_json" ->> 'cost_usd') STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "heartbeat_runs_context_issue_id_idx"
  ON "heartbeat_runs" USING btree ("context_issue_id")
  WHERE "context_issue_id" IS NOT NULL;
