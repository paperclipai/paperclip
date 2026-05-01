-- Denormalize hot result_json keys into top-level stored generated columns.
-- Mirrors the migration 0079 pattern (context_snapshot keys); same JSONB
-- detoast cost was hitting the heartbeat list query for the result_json
-- column. The list projection in `heartbeat.ts:heartbeatRunListResultColumns`
-- evaluates 7 `result_json ->> ...` extracts per row, each of which has to
-- detoast the full result_json blob (up to 64 KB safe-cap, often pglz
-- compressed against the 262 MB total result_json TOAST on the kkroo
-- cluster). Generated stored columns make those reads small-text projections
-- with no detoast.
--
-- The text fields (summary / result / message / error) get truncated to
-- HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS (500) at write time — same length
-- the runtime list query was already enforcing via `left(..., 500)`. The
-- numeric-string cost fields are stored full because they're tiny.
--
-- WARNING: Same locking caveat as 0079. AccessExclusive on heartbeat_runs
-- for the duration of the table rewrite (~30-60 s on the kkroo cluster).
-- Schedule the deploy that picks up this migration during a low-activity
-- window. If HEARTBEAT_RUN_RESULT_SUMMARY_MAX_CHARS changes in TypeScript,
-- write a follow-up migration that drops + re-adds these columns with the
-- new bound — Postgres does not support changing a generated expression
-- in place.
ALTER TABLE "heartbeat_runs"
  ADD COLUMN "result_summary" text GENERATED ALWAYS AS (left((result_json ->> 'summary'), 500)) STORED,
  ADD COLUMN "result_result" text GENERATED ALWAYS AS (left((result_json ->> 'result'), 500)) STORED,
  ADD COLUMN "result_message" text GENERATED ALWAYS AS (left((result_json ->> 'message'), 500)) STORED,
  ADD COLUMN "result_error" text GENERATED ALWAYS AS (left((result_json ->> 'error'), 500)) STORED,
  ADD COLUMN "result_total_cost_usd" text GENERATED ALWAYS AS ((result_json ->> 'total_cost_usd')) STORED,
  ADD COLUMN "result_cost_usd" text GENERATED ALWAYS AS ((result_json ->> 'cost_usd')) STORED,
  ADD COLUMN "result_cost_usd_camel" text GENERATED ALWAYS AS ((result_json ->> 'costUsd')) STORED;
