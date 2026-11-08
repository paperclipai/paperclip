# Phase 2 reconciler data: harsh local chaos waves

Status: Phase 2, step 1 deliverable, 2026-11-07.
Plan: [`2026-11-07-durable-ownership-and-reconciliation.md`](2026-11-07-durable-ownership-and-reconciliation.md).
Inventory: [`2026-11-07-ownership-inventory.md`](2026-11-07-ownership-inventory.md). Budgets: `server/src/services/native-runtime/native-speed-budgets.ts` (#19863).

## Summary

Phase 1's light waves showed zero invariant violations. Five harsher local waves, all unmasked, change the picture in three ways:

1. **The existing per-subsystem paths settle most run-lifecycle records within 45 s of `ready`, but this is not a bound.** Most owners proven gone were seen while the control plane was down or recovering, and they were settled before the first sampler pass more than 45 s after `ready`. There are three exceptions:
   - one active environment lease of a terminal run settled 119 s after `ready`;
   - in the s9204 storm, six native claims were still proven gone during the load-61 window;
   - the leak in finding 2.

   The 20 s sampling interval limits all of these numbers.
2. **One kind leaks: a claimed wake whose run ended without settling it.** Native restart recovery blocked a run (`native_restart_recovery_blocked`, `execution_recovery_budget_exhausted`) and ended it, but left the run's assignment wake `claimed`. It stayed that way for more than 24 minutes, until the wave ended. Nothing releases it. Rule I2 caught it. This is the first Phase 2 settle target the data found. Its PR is listed under "Step 2" below.
3. **Unowned and unstamped records are the main I1 finding:**
   - `environment_pending_cleanup` (61 records across the valid waves). These are cleanup jobs that are queued but not claimed, so they have no owner by design.
   - `usage_receipt_spool` files (4 records).
   - `run_accounting_debt` rows. They are always `unprovable`, because they carry no owner stamp.

Long holds (K4 up to 579 s, so outages up to 588 s, past the Runner's 7-minute reconnect grace) all recovered: 6 of 6 tasks passed. Crash loops passed too (6 of 6).

TTFT, boot and restart recovery stay within the p50 budgets for cold starts and for recovery. The exceptions are claude cold TTFT, at the budget (16.3–17.5 s against 16.5 s), and warm follow-ups on claude (about 3×) and codex (slightly over). See "Speed".

Daytona did not run in this pass. A follow-up adds one Daytona wave. See "Not covered".

## Waves

All waves ran local, unmasked, with `--keep`, on Apple M5 Max (18 cores) alongside other sessions. Every fault receipt records the host load (`loadAvg1m`).

| Wave | Base | Shape | Graded | Crossed a fault | Passed | Faults |
|---|---|---|---|---|---|---|
| `w-20261107T221244-s9201` | `ee556a266d` + harness flag | K13 storm 45 min, 5 in flight, triggers `time,result` | 58 | 30 | 51 | 16 (K1 ×2, K2 ×10, K6 ×4), load 3.5–10.2 |
| `w-20261107T221303-s9202` | same | K6 crash loop, 6 tasks, 3 adapters | 6 | 5 | 6 | 5, load 4–10 |
| `w-20261107T221304-s9203` (first run) | same | K4, holds up to 600 s | 6 | 5 | 3 | 5. Invalid: harness defect, see below |
| `w-20261107T225750-s9203` (rerun) | `ee556a266d` + harness fix | K4, holds 294–579 s | 6 | 6 | 6 | 6, outages 306–588 s |
| `w-20261107T231436-s9204` | `94718ce168` + harness | K13 storm 40 min, 6 in flight, K4 holds up to 600 s mixed in | 42 | 31 | 36 | 13 (K1 ×5, K2 ×5, K4 ×2 at 421 and 215 s, K6 ×1) |

Failure classes:

- **Harness (T):** the first K4 run failed 3 tasks on R1. Its outage receipt required `ready` within 420 s of the stop, so every hold over about 405 s failed the fault. #19797 raised the hold cap to 600 s but never made it usable. The fix is in this PR: runner suites keep the 420 s bound, and chaos passes hold + 420 s.
- **Storm shape (not P):** 8 B5 tasks failed R1 across both storms. Each crossed 10–16 faults. A 4-minute `bench.sh` killed every 2–4 minutes cannot finish within its budget, and every one of these issues still ended `done`. This is the long-tool boundary (B6) under a storm, not an ownership record.
- **Agent quality (Q):** 3 T-oracle failures (`brief_contains_followup_marker`). Two crossed no fault.
- **Load (E):** in the s9204 storm, fault f12 fired at load 61 and f13 at load 24. f13's server did not become healthy within 180 s. My own concurrent test run caused the load. The last A1 R1 failure falls in this window, and so do the sampler's I2 hits on six native claims.
- **Product (P), new:** the stuck claimed wake (finding 2).

## Per-kind data

There are two sources:
- the product reconciler's `recovery.invariant_violation` rows in each kept database;
- a read-only sampler that ran the Phase 1 pass (`record: false`) against each wave's database every 20 s.

The sampler counts in the second table skip passes that fall inside a fault window (from fault start to `ready` + 45 s), because nothing can settle while the server is down.

Violations recorded by the reconciler, counted as distinct records:

| Rule | Kind | s9201 | s9202 | s9203 rerun | s9204 | Example | Meaning |
|---|---|---|---|---|---|---|---|
| I1 | `environment_pending_cleanup` | 47 | 4 | 4 | 6 | `00cb373d…` (run `13d667d1…`) | Unclaimed cleanup obligations name no owner by design. A modelling gap, not a leak: every one reached `expired` within about 1 min. |
| I1 | `usage_receipt_spool` | 3 | 0 | 0 | 1 | `2357b5be…` | Spool files carry no owner stamp. |
| I2 | `wake_request_claimed` | 0 | 0 | 1 | 0 | wake `6b3c4cce…`, run `7c45860b…` | Run failed at 23:19:41 (`native_restart_recovery_blocked`). Wake still `claimed` at the end of the wave (23:44+). A real leak. |
| I4 | `wake_request` | 0 | 0 | 1 | 0 | `f7082368…` | False positive. The wake failed "Process lost… retrying once", and retry run `1820a14b…` delivered it and succeeded. The report's refusal regex matches "retry". |

There were no I3 violations: no run held admission past the 10-minute accounting closure in any wave. There were no I7 violations.

Owner verdicts from the sampler outside fault windows (record-passes):

| Kind | Peak in progress | Gone | Alive | Unprovable (reason) |
|---|---|---|---|---|
| `environment_run_lease_active` | 56 | 1 (`owner_run_terminal`, settled 119 s after ready) | 3,636 | 0 |
| `issue_execution_lock` / `issue_checkout_lock` | 8 | 0 | 846 each | 0 |
| `wake_request_claimed` | 8 | 2 (the leak above) | 846 | 0 |
| `native_executor_claim` | 6 | 1 (load window) | 285 | 0 |
| `native_restart_recovery_claim` | 7 | 5 (load window) | 548 | 0 |
| `native_accepted_result_lease` | 1 | 0 | 3 | 0 |
| `run_accounting_debt` | 3 | 0 | 0 | 44 (`no_owner_stamp`) |
| `legacy_controller_lease` | 1 | 0 | 0 | 4 (`missing_identity`) |
| `environment_pending_cleanup` | 29 | 0 | 0 | 78 (`no_owner_stamp`) |

Gone owners seen while the server was down or recovering, in record-passes over all waves:

| Kind | Record-passes |
|---|---|
| `native_restart_recovery_claim` | 72 |
| `native_executor_claim` | 56 |
| `wake_request_claimed` | 61 (K4 rerun) |
| `native_accepted_result_lease` | 3 |

Except for the claimed wake, one environment lease (119 s after `ready`) and the load window above, existing paths settled them before the first pass more than 45 s after `ready`. Pending-cleanup leases were retried and released 46–58 s after their run finished. That is far below the inventory's 5-minute age rule, which never fired.

What this does and does not show:
- These waves reach the run-lifecycle kinds, the issue locks and the wake queue. They do not reach the remote, workspace-operation, sandbox or accounting kinds that hurt the overnight campaign most: teardown claims, create intents, writer lanes and the age-only list in the inventory. Those need Daytona waves or the crash-point suite.
- "Within 45 s" describes most records, with the exceptions above. It is a sampling observation (20 s passes), not a measured latency or a guarantee.

## Speed against the #19863 budgets

Runs that no fault crossed, merged over both storms (n in brackets), in seconds:

| Adapter | Start | TTFT p50 (budget p50) | TTFT p95 (budget p95) | Boot p50 (budget p50) | Boot p95 (budget p95) |
|---|---|---|---|---|---|
| claude | cold | 16.3–17.5 [18] (16.5) | 23.5–30.8 (30.0) | 4.2 (9.0) | 4.8–6.8 (20.5) |
| claude | warm | 27.6–29.9 [13] (9.5) | 54.4–76.6 (28.5) | 1.8–2.0 (3.5) | 4.2–5.3 (16.5) |
| codex | cold | 4.8–4.9 [20] (6.0) | 6.2–7.6 (17.0) | 1.6–1.8 (2.5) | 3.1–3.6 (7.0) |
| codex | warm | 10.2–11.0 [12] (10.0) | 18.4–72.8 (28.5) | 2.5–2.6 (5.0) | 4.2–4.7 (16.5) |
| opencode | cold | 10.8–11.0 [23] (17.5) | 16.3–22.1 (49.0) | 6.7 (12.0) | 9.2–9.9 (37.0) |
| opencode | warm | 19.3 [2] (26.5) | 94.5 (88.0) | 6.1 (22.0) | 6.4 (65.5) |

Ranges give the two storms' values. The crash-loop and outage waves had only 1–2 uncrossed runs per cell, all inside these ranges.

Restart recovery, from `ready` to the recovered run's next provider event. A sample counts only when that event comes before the next fault starts. Otherwise the run has no next event for this fault, because a later event measures a later fault.

| Adapter | p50 s1 / s2 (budget 15.0 / 6.5 / 25.5) | p95 s1 / s2 (budget 22.5 / 8.0 / 38.5) | Samples |
|---|---|---|---|
| claude | 5.0 / 4.2 | 9.4 / 5.4 | 21 / 17 |
| codex | 4.5 / 4.6 | 9.1 / 9.1 | 36 / 24 |
| opencode | 10.8 / 10.3 | 14.3 / 13.4 | 28 / 18 |

Crash loop (s9202): claude 3.4 / 4.7 s (n 5), opencode 9.5 / 10.4 s (n 6); no codex run crossed a fault.

K4 rerun (s9203, outages 306–588 s): of 10 runs in flight at a fault, only 2 emitted a provider event before the next fault: claude 5.8 s and opencode 10.8 s, both within budget. The other 8 (all 4 codex runs included) had no event before the next fault. After an outage past the reconnect grace, the run continues through a retry or a new run, not by reattaching, so this metric does not measure it. A first version of this table counted events after later faults, which inflated the s9204 p95 to 42–49 s.

Findings:
- **Warm follow-up TTFT is over budget on claude (about 3×) and slightly on codex.** In C1 the follow-up comment is posted while the first turn is still running. TTFT is anchored at message acceptance, so it includes waiting for the live turn to finish. The baseline measured idle follow-ups. This needs a TTFT anchor that separates "queued behind the live turn" from "turn start to first token" before it is called a regression.
- Codex restart-recovery p95 (9.1 s in both storms) is just over its 8.0 s budget, with 4 run-log breaches (max 9.4 s) in the first storm.
- Recovery after an outage past the reconnect grace needs its own metric: from `ready` to the first provider event of the run that continues the task (the retry), not of the interrupted run.
- No change in this phase adds work before `turn.start`. The settle paths run in restart recovery and in the background reconciler.

## Step 2: kinds moved to the shared path

Order of the moves, highest risk first:
- **Accepted-result executor lease** (`native_accepted_result_lease`). It is an accepted-result obligation, and the storm saw its owners proven gone. It had its own liveness proof (`native-dead-controller-result-lease.ts`, #19713), which the move deletes. PR: feat/ownership-settle-accepted-result-lease.
- **Claimed wake** (`wake_request_claimed`). This is the leak the data found. Settle copies the finished run's outcome onto the claim once the run, and for native runs its coordinator, is final. PR: feat/ownership-settle-claimed-wake.

Both release only on proof:
- for the lease, `proveOwnerGone` returns gone;
- for the wake, the owner run's terminal row.

An unprovable owner is never released. The lease kind keeps the one-release legacy fallback for rows saved before #19868, and logs each use (#19883). An ephemeral server asks the board to confirm the stop instead.

## Phase 3 gates the data bears on

Phase 3 is not started. It needs a separate go-ahead.

- **`waitingRunCount` and `recoveringRunCount`** (budget-exposure.ts, budgets.ts). Across 112 graded, unmasked tasks in the valid waves, no run held admission past the accounting closure: there were no I3 violations, and accounting debt peaked at 3 rows and always cleared. Locally the data gives no evidence that these gates prevent anything. Removing them is the planned direction (decision 1), and these waves raise no objection. They do not cover remote accounting or late receipts.
- **Scope budget hold and the 15 s `budget_evaluation_work` gate.** These waves never exercised them; no run hit a hard stop. No evidence either way.
- **`hasPendingRunCleanup` successor block.** It fails closed when the run row is missing. No I7 violations were seen, so it never stranded a task in these waves. No evidence either way.

## Not covered

- **Daytona.** No signed runner image existed for the tested commit.
  - An apparent content-ID mismatch with CI run 42422571919 was a misreading: that run was dispatched from master but built target commit `a37a2e4`, and its Daytona image step was skipped.
  - Local content IDs reproduce CI's for the same commit; for example, `35d41f11` gives `11475796…` on both.
  - A follow-up builds an `image_only` image and adds one Daytona wave.
- The remote, workspace-operation, sandbox and accounting kinds (see "Per-kind data").
- Crash points that sit between two durable writes. Random waves hit 20 ms–1 s windows only by luck. The crash-point suite (Phase 5) is the tool for those.

## Reproduce

```sh
node scripts/agent-preflight.mjs
set -a; source ~/.secrets; set +a   # in the harness command's own shell only
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local --adapters codex,claude,opencode \
  --concurrency 6 --storm-minutes 40 --triggers time,result --k4-hold-max-seconds 600 --seed 9204 --keep
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local --adapters codex,claude,opencode \
  --faults K4 --k4-hold-max-seconds 600 --tasks 6 --concurrency 3 --seed 9203 --keep
```

To count violations, copy the kept instance's database and query it:

```sql
select details->>'rule', details->>'kind', count(distinct entity_id)
from activity_log where action = 'recovery.invariant_violation' group by 1, 2;
```
