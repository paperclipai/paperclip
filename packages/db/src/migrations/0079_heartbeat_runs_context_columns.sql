-- Denormalize hot context_snapshot keys into top-level stored generated
-- columns. The `heartbeat_runs.list` SQL projects 8 keys via
-- `context_snapshot ->> 'X'` for the Inbox / IssueRunLedger / AgentDetail
-- views; on a busy company that's a per-row JSONB detoast (the eBPF profile
-- showed pglz_decompress at ~14% of pg CPU under list load, with a 100-row
-- list returning in 4.2 s on the kkroo cluster). Generated stored columns
-- materialize the values at insert/update time so the list query reads
-- small text columns directly with no detoast.
--
-- WARNING: This migration locks `heartbeat_runs` (AccessExclusive) for the
-- duration of the table rewrite — Postgres has to compute the generated
-- value for every existing row, which means detoasting each context_snapshot
-- once. On the kkroo cluster (~14k rows / 285 MB total relation size) this
-- is ~30-60 s of blocked reads/writes. Schedule the deploy that picks up
-- this migration during a low-activity window. Agents that heartbeat during
-- the lock will queue their updates; recoverable, but visible.
ALTER TABLE "heartbeat_runs"
  ADD COLUMN "context_issue_id" text GENERATED ALWAYS AS ((context_snapshot ->> 'issueId')) STORED,
  ADD COLUMN "context_task_id" text GENERATED ALWAYS AS ((context_snapshot ->> 'taskId')) STORED,
  ADD COLUMN "context_task_key" text GENERATED ALWAYS AS ((context_snapshot ->> 'taskKey')) STORED,
  ADD COLUMN "context_comment_id" text GENERATED ALWAYS AS ((context_snapshot ->> 'commentId')) STORED,
  ADD COLUMN "context_wake_comment_id" text GENERATED ALWAYS AS ((context_snapshot ->> 'wakeCommentId')) STORED,
  ADD COLUMN "context_wake_reason" text GENERATED ALWAYS AS ((context_snapshot ->> 'wakeReason')) STORED,
  ADD COLUMN "context_wake_source" text GENERATED ALWAYS AS ((context_snapshot ->> 'wakeSource')) STORED,
  ADD COLUMN "context_wake_trigger_detail" text GENERATED ALWAYS AS ((context_snapshot ->> 'wakeTriggerDetail')) STORED;
