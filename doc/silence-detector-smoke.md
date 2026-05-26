# Silence-detector run-storm fix — manual smoke playbook

This playbook walks QA through verifying the silence-detector fix in a live
instance. The four properties under test:

1. **Coalesce** — one open review issue per silent run.
2. **24h closed window + backoff** — closing a review false-positive does not
   trigger a new review during the backoff cool-down, and the multiplier grows
   on repeat closes.
3. **Auto-cancel at critical + dead pid** — the run is cancelled (not escalated)
   when the process is already gone and silence age is past 4h.
4. **Operator override** — a board comment "cancel this run" on a review issue
   reliably terminates the run and cancels sibling reviews.

> All steps reference a single test agent (`Coder`) in a fresh company. Replace
> placeholders (`<RUN_ID>`, `<COMPANY_PREFIX>`, `<PID>`) with the values shown
> in your instance.

## Prereqs

- Local Paperclip server running on `:3100`.
- `psql` configured against the same database (or use the in-app activity-log
  viewer instead).
- An agent named `Coder` with adapter `codex_local` (any local adapter that
  exits silently is fine for the simulation).

## 1. Bootstrap a silent run

1. Pick or create an issue assigned to `Coder` (the **source issue**).
2. Trigger a heartbeat for that issue.
3. As soon as the run starts, before any output is produced, kill the
   underlying process by hand:

   ```bash
   ps aux | grep <agent-binary>
   kill -9 <PID>
   ```

4. **Do not** clean up the in-memory `runningProcesses` entry — the test is
   that the silence detector will notice the missing handle on its own.

## 2. Verify coalesce — one review issue per run

1. Wait until silence age > 1h. (For impatience, you can fast-forward by
   tampering with `heartbeatRuns.processStartedAt` directly in psql — set it
   to `now() - interval '70 minutes'`.)
2. Trigger `scanSilentActiveRuns` either by waiting for the recovery timer
   tick or by invoking it manually via the dev console.
3. Confirm that **exactly one** issue is created with
   `originKind = 'stale_active_run_evaluation'` for the silent run id:

   ```sql
   SELECT identifier, status, priority, created_at
   FROM issues
   WHERE origin_kind = 'stale_active_run_evaluation'
     AND origin_id = '<RUN_ID>';
   ```

4. Trigger the scan again immediately. The previous issue should still be the
   only one. Activity log should show `heartbeat.output_stale_detected` once
   and no additional row.

## 3. Verify 24h closed window + backoff

1. Close the review issue from §2 as `done` with comment "False positive".
2. Trigger another scan immediately. Verify in the activity log:

   ```sql
   SELECT action, created_at, details
   FROM activity_log
   WHERE run_id = '<RUN_ID>'
     AND action = 'heartbeat.output_stale_dedup_suppressed'
   ORDER BY created_at DESC LIMIT 5;
   ```

   You should see exactly one suppressed entry.

3. Inspect the silence-state row — multiplier should be 2 after one
   false-positive close:

   ```sql
   SELECT consecutive_false_positives, backoff_multiplier,
          last_closed_at, next_eligible_scan_at
   FROM heartbeat_run_silence_state
   WHERE run_id = '<RUN_ID>';
   ```

4. Fast-forward the system clock past `next_eligible_scan_at`. Run another
   scan. A **new** review issue should be created (the backoff cool-down has
   elapsed). Close that one false-positive too. Repeat one more time. After
   three close cycles, `backoff_multiplier` should be 8, capped by the
   schema-defined ceiling.
5. Snooze the run via the watchdog UI (or `POST /api/heartbeat-runs/:id/snooze`).
   Verify the silence-state row resets: `backoff_multiplier = 1`,
   `consecutive_false_positives = 0`, `next_eligible_scan_at = NULL`.

## 4. Verify auto-cancel at critical + dead pid

1. Re-prepare a silent run with the underlying process already killed.
2. Advance `processStartedAt` so that `silence_age_ms >= 4h` (the critical
   threshold).
3. Ensure no in-memory handle exists for the run (the server restart from
   §1 already did this; otherwise inspect `runningProcesses` via the dev
   diagnostics endpoint).
4. Trigger one scan. Expected outcome — **no new review issue**, run status
   transitions to `cancelled` with `errorCode = 'silence_auto_cancel'`, and
   activity log shows `heartbeat.output_stale_auto_cancelled`:

   ```sql
   SELECT status, error_code, finished_at
   FROM heartbeat_runs WHERE id = '<RUN_ID>';
   SELECT action, details
   FROM activity_log
   WHERE run_id = '<RUN_ID>' AND action = 'heartbeat.output_stale_auto_cancelled';
   ```

5. Confirm the source issue's execution lock was released:

   ```sql
   SELECT execution_run_id, execution_locked_at FROM issues WHERE id = '<SOURCE_ISSUE_ID>';
   ```

   Both columns must be `NULL`.

## 5. Verify operator override

1. Reproduce a silent run as in §1. Allow the silence detector to create one
   review issue (§2).
2. Comment on that review issue as a board user — body must match the
   grammar `/(cancel|kill|abort)\s+(this\s+)?run/i`. Example:
   `Please **cancel this run** immediately.`
3. Within a second or two of posting, expect:
   - `heartbeat_runs.status = 'cancelled'`, `error_code = 'operator_override'`
   - Source issue execution lock cleared.
   - A confirmation comment posted by the system on the review issue,
     starting with `## Operator override accepted`.
   - `heartbeat.output_stale_operator_override` row in the activity log.
4. Negative case: post the same comment as an `agent` actor (not board).
   The run should NOT be cancelled and no confirmation comment should be
   posted.

## Rollback

The schema migration `0091_heartbeat_run_silence_state` is additive and
reversible:

```sql
DROP TABLE IF EXISTS heartbeat_run_silence_state;
```

If you need to revert behavior in production, restore the prior version of
`server/src/services/recovery/service.ts` and the surrounding wiring.
Existing review issues are unaffected.

## Reporting issues

Attach the activity-log slice for the affected `run_id` plus the
`heartbeat_run_silence_state` row contents when reporting any regression.
