# Control-plane restart chaos loop: make tasks survive server restarts

Date: 2026-11-06
Target: a local, isolated Paperclip control plane with agent runs in Daytona sandboxes
Fix workflow: `fix-failed-paperclip-run` (one session per failure signature)
Predecessor: `2026-11-04-staging-soak-loop.md` (staging soak campaign, PR worktree `paperclip-staging-test-plan-24ca37`)

## 1. Why this plan exists

The staging soak campaign (2026-11-04 to 2026-11-06) ran about 430 graded tasks
in waves of about 10. It used a fixed task library (sections A to H), mechanical
oracles (U1 to U9), and a dedupe-by-signature ledger. Each new failure signature
went to its own `fix-failed-paperclip-run` session. The campaign merged 42 fixes,
and the hard-failure rate on test tasks fell from 43% to about 0%.

The largest remaining source of failures was restarts. Staging restarted up to
about five times an hour. The campaign summary says "frequent restarts stall
in-flight work". Three fixes in this area merged late in the campaign:

- #19399: lost runner after a restart continues automatically, and Retry is offered.
- #19426: a declined Retry no longer swallows later clicks (the "dead Retry" bug).
- #19431: queued runs start promptly after a restart, and the wait shows a reason.

The campaign could only observe restarts that staging happened to perform. We
could not choose when the restart came, what kind it was, or what each run was
doing at that moment. This plan reverses that: **we cause the restarts on
purpose**, against a local control plane whose runs execute in Daytona. We run
many tasks at once and repeat until nothing breaks.

## 2. Success rule (the oracle)

A run is **restart-crossing** if any part of it overlaps a control-plane fault:
its queued wake, preparation, provider turn, finalization, or a follow-up. Every
restart-crossing task must meet all of the rules below.

| ID | Rule | Failure means |
| --- | --- | --- |
| **R1** | **Automatic continuation.** If continuing is safe, the task resumes after the server is back, with no user action, and reaches its expected resting state within the task's time budget plus the outage time. | Not robust to restart |
| **R2** | **Durable workspace.** No workspace, durability, or recovery error stays visible at rest. This includes restore, snapshot, finalize, writer-pending, lease mismatch, and stranded lock errors. If such an error appears during recovery, it clears by itself. Files the agent wrote before the fault are present afterwards, and nothing is silently rolled back. | Durability bug |
| **R3** | **Working Retry.** If the task cannot safely continue on its own, it shows exactly one Retry or continue affordance. One click (`POST /api/issues/:id/retry`, and the button in the UI) starts a run that completes the task. "Send a message to continue", a Retry that does nothing, a missing Retry, or a Retry that needs several clicks all fail this rule. | Dead or missing Retry |
| R4 | No duplicate execution. There is at most one active run per issue, no side effect is repeated, and no user message is consumed twice. This is soak oracle U4 and U5. | Replay or duplicate run |
| R5 | No silent stall. A task is never `in_progress` or `queued` with no live run, no queued wake, and no named wait reason for more than 3 minutes after `/api/liveness` reports ready. | Stall |
| R6 | Clean rest. At the end of the wave there is no pending workspace operation, recovery action, orphaned lease, or orphaned Daytona sandbox. | Leak |

The paid "kill at an arbitrary point" probes (`recover-runner*`, see
`tests/runner-recovery/README.md`) were retired because they demanded
**automatic completion** after any kill. For a turn whose outcome is unknown,
automatic completion is not always safe. R1 and R3 resolve this: when automatic
continuation is not provably safe, the correct result is a Retry that works on
the first click. A random kill therefore always has a defined pass condition. It
is never graded "environment, ignore".

## 3. Topology

```
 chaos harness (Node script, no LLM)
   ├─ supervisor: owns the server process (start, SIGKILL, SIGTERM, hot restart, outage hold)
   ├─ launcher: creates tasks through the board API
   ├─ observer: polls issues, runs and run events; grades R1–R6; captures evidence
   └─ ledger: one JSONL line per task execution, plus the fault schedule seed

 local control plane (isolated PAPERCLIP_HOME, embedded Postgres, one fixed port)
   └─ dials out to runnerd in each Daytona sandbox (runner ingress, port 43127)

 Daytona: one sandbox per run or lease, holding the real runner and provider (Claude, Codex)
```

- **Use an isolated instance**, not `~/.paperclip/instances/default`. Chaos kills
  and the leftover Postgres state must never touch Dotta's working data.
- **Own the server process.** Reuse the existing supervisor in
  `tests/runner-e2e/server.ts` and `controller-outage.ts`
  (`replaceController`: stop → wait for unhealthy → hold → start → ready, with a
  receipt). It already handles process groups, SIGKILL escalation, and
  embedded-Postgres ownership. Do not use `pnpm dev` (watch mode): when its child
  dies, the dev runner exits too.
- **Readiness.** Use `/api/liveness` and the startup phases
  (`starting → recovering → ready`) to time the outage and the recovery window.
  `startup-recovery-timing.ts` logs each phase.
- **Keep across restarts:** the Postgres data and the instance secret key. A
  restart that loses either one is a different fault (K11) and is graded on its
  own.
- **Concurrency.** Start with 6 concurrent tasks and raise to 12, then 20. The
  limits are the Daytona sandbox quota and provider spend. Settle the quota in
  Phase 0.

## 4. Fault menu

### 4a. What the fault does (K)

| ID | Fault | How |
| --- | --- | --- |
| K1 | Hard kill, fast return | SIGKILL the server, restart immediately. Hot-restart reconciliation reports `not_requested`. |
| K2 | Graceful stop | SIGTERM (shutdown drain and finalizers run), then restart. |
| K3 | Hot restart | `scripts/request-hot-restart.ts`, then SIGTERM. Runs should be adopted. |
| K4 | Medium outage | Hard kill and hold for 2–5 minutes. This exceeds the 60-second controller lease but stays within the 7-minute runner reconnect grace. |
| K5 | Long outage | Hard kill and hold for 8–20 minutes. This exceeds the reconnect grace, and past 15 minutes Daytona auto-stops idle sandboxes. The runner gives up, so recovery must go through saved work. |
| K6 | Crash loop | Kill again during `recovering`, then a third time just after `ready`. |
| K7 | Kill during the automatic retry | Kill again while the automatic retry or continuation started by R1 is running. |
| K8 | Kill during a user's Retry | Kill between the Retry click (receipt committed) and the start of the new run. |
| K9 | Postgres dies too | SIGKILL embedded Postgres along with the server. |
| K10 | Network partition, no restart | Block the server's outbound traffic to Daytona for 30 seconds to 5 minutes. |
| K11 | Lost local state | Restart with the controller cache and scoped state directory deleted, as on a new container (`remote_reattach_root_missing`). The database is kept. |
| K12 | Rolling deploy | Start a second server on the same database before stopping the first, as in `rolling-deployment-supervisor.ts`. |
| K13 | Restart storm | Restart every 2–4 minutes for an hour with 20 tasks running. |

### 4b. When the fault hits (B, run boundary)

Some faults fire at a **random time**: a seeded random generator chooses the
time, so a failure can be replayed. Others are **boundary-triggered**: the
observer watches run events and status and fires the fault at a chosen
transition. Each boundary below lists the run event or state it fires on.

| ID | Boundary | Fires on |
| --- | --- | --- |
| B1 | Queued, not yet dispatched | Run `queued` |
| B2 | Sandbox acquire or provision | Lease acquire started, sandbox not ready |
| B3 | Workspace restore or prepare | Restore or prepare operation in progress |
| B4 | Runner bootstrap or session open | Native bootstrap events |
| B5 | Mid model turn, streaming | First assistant output event |
| B6 | Mid long tool call | Tool-start event without a tool-end, for example `bench.sh` running about 4 minutes |
| B7 | Waiting on a question or approval | Pending interaction |
| B8 | User message or steering queued during the run | Queued comment exists |
| B9 | Turn done, finalization or sync-out in progress | `workspace_finalize` or sync operation running |
| B10 | Snapshot or archive upload | Snapshot upload begun |
| B11 | Done, before publication | Durable done, reply not yet published (as in the chat-restart cell) |
| B12 | Scheduled-retry backoff | Run `scheduled_retry` |
| B13 | Stop or interrupt settling | Cancel requested, not settled |
| B14 | Parent waiting on delegated children | Parent blocked on children, children running |
| B15 | Routine fire or timer wake | Routine run being created |
| B16 | Reassignment in flight | Assignee changed, old run not ended |

The `finalization-crash-boundary.ts` and `controller-recovery-observer.ts`
modules in `tests/runner-e2e/` already bind kills to some of these boundaries.
Reuse them; do not write them again.

### 4c. Workload (W)

Use a smaller subset of the soak library, chosen so the boundaries above occur
naturally:

- **A1:** brief written to an issue document. A short run with no repository.
- **A3:** CSV analysis whose answer can be checked exactly.
- **B1:** Python CLI with tests. Workspace files must survive the fault. The
  harness runs the tests itself.
- **B2:** fix a failing test, plus a revision follow-up. This exercises workspace
  reuse across the fault.
- **B5:** a long `bench.sh` run, which reaches boundary B6.
- **C1:** a comment sent while the run is active (B8).
- **C2:** Stop, then a new direction (B13).
- **A5:** the agent asks a clarifying question (B7).
- **D1:** CEO delegates to children (B14).
- **E1** or **H10:** a routine (B15).
- **C6:** reassignment (B16).

Each task has a deterministic T-oracle, so a restart cannot hide wrong output.

### 4d. Adapter (A)

- **Primary:** native Claude and native Codex on Daytona.
- **Control:** the same tasks with a local runner. This tells apart failures
  that are Daytona-specific from failures in control-plane recovery.
- **Later:** other adapters, once the primary pair is green.

The full cross product is about 13 × 16 × 11 × 2. That is too large to run
exhaustively. Waves therefore sample **pairwise coverage**: every fault paired
with every boundary, and every boundary on every adapter, at least N times. The
remaining slots go to open signatures and random K1 and K13 storms.

## 5. Harness (`tests/restart-chaos/`)

The harness is a script, not an LLM, for the same reasons as the soak harness:
deterministic grading and cheap polling. It reuses the runner-e2e process code.
It does not copy that code.

1. **`config`:** isolated instance path, port, `DAYTONA_API_KEY`, company,
   agents, budget, and concurrency.
2. **`seed`:** creates the "Chaos Lab" company, Claude and Codex agents on
   Daytona, and the `chaos-sandbox` project with a fixture repository. This
   includes `bench.sh` and one failing test. It sets hard budgets.
3. **`supervisor`:** wraps `server.ts` and `controller-outage.ts`, exposing
   `kill(kind)`, `hold(ms)`, `start()`, `waitReady()`, `partition(ms)` (for
   example a pf or iptables rule, or a proxy in front of runner ingress), and
   `wipeLocalState()`. Every action is written to the timeline.
4. **`scheduler`:** a seeded plan of faults and boundaries for each wave. The
   seed and the chosen cells are saved, so `--replay <wave>/<task>` repeats the
   same fault at the same boundary.
5. **`observer`:** polls every 2–5 seconds and evaluates R1–R6 and the
   T-oracles. When a task ends in the R3 state, the observer acts as a user
   would: it calls Retry once through the API, the same call the UI hook makes
   in `useTaskRetry.ts`, and grades the result.
6. **`ui-probe`:** every few waves, a Playwright pass opens one task that is in
   the R3 state, checks that the Retry button is visible, clicks it once, and
   confirms the task continues. The dead-Retry bug (#19426) was in the UI path,
   so checking the API alone is not enough.
7. **`evidence bundle`** (captured at failure time): run IDs and statuses, the
   last 200 run events for each run, the server log around the fault, the
   startup-phase timings, the recovery claim dispositions
   (`claimNativeRestartRecoveries`), workspace operations, leases and their
   Daytona sandbox state, the fault timeline, the seed, and the SHA.
8. **`ledger` and summary:** the soak ledger format, plus the fault, boundary
   and adapter fields. A small dashboard artifact shows pass rate per cell and
   the open signatures.
9. **`sweep`:** at the end of each wave, reconcile Daytona sandboxes against
   leases (R6). Then destroy whatever the harness created.

## 6. Triage and the fix loop

```
wave (N tasks × sampled K/B/A cells)
  → grade R1–R6 and the T-oracles
  → classify failures; signature = component + first causal error + boundary
  → new P signature  → fixer session running /fix-failed-paperclip-run with the bundle and a replay command
  → known signature  → add the bundle to the existing record
  → fix PR merged    → rebase the harness worktree on master, replay that signature 5× plus its neighboring cells
```

- **Classes:** the same as the soak campaign. **P** is a product bug, **Q** is
  agent quality, **T** is a test or harness defect. **E** (environment) never
  applies to the fault we injected. Only an unrelated provider or Daytona outage
  counts as E.
- **Fixers start from the replay.** Each fixer gets `--replay`, so the first
  step of `fix-failed-paperclip-run` (establish the incident) is already done.
  The fixer then writes the smallest red test at the right layer. Usually that
  is a server integration test on embedded Postgres, like the six in #19399, or
  a `native-runner-restart-*.integration.test.ts`. The fix makes it green.
- **Merge authority:** the same as the soak campaign. Fixer sessions merge their
  own PR at Greptile 5/5 with all required checks green, and run `check-pr`.
- **Concurrency:** at most 4 fixer sessions at once.
- **No deploy lag.** Fixes are retested locally as soon as they merge, which is
  the main speed advantage over the staging loop. Staging stays the final
  confirmation (Phase 4).

## 7. Phases

| Phase | Output | Exit |
| --- | --- | --- |
| **0. Baseline** | Isolated instance, Daytona key and quota confirmed, Chaos Lab seeded. Run the existing `everyday-workflows.runner-codex.daytona.recover-controller` cell and `controller-replacement-smoke.ts` as they are today. Also run 10 tasks by hand with a K1 kill each, to measure the starting failure rate. | The baseline failure rate is recorded and the first signatures are filed. |
| **1. Harness MVP** | Supervisor, launcher, observer with R1–R6, ledger and replay. Faults K1, K2 and K4 at random times. Workloads A1, B1, B5 and C1 on Claude and Codex. 6 concurrent tasks. | Two waves run without supervision, and the evidence bundles are good enough for a fixer to start from. |
| **2. Boundary matrix** | Boundary triggers B1–B16 and the full K list except K12 and K13. Pairwise sampling. UI probe. | Every K×B pair has been run at least 3 times. |
| **3. Stress** | Concurrency 12, then 20. K13 storms (an hour of restarts every 2–4 minutes). K12 rolling deploys. Overnight runs. | Finish line (§8). |
| **4. Lock in** | Each fixed signature has a red/green regression test in its PR. Stable cells are promoted to explicit runner-e2e cells (`recover-controller` style) for release qualification. Then one confirmation wave on staging. | Recurring regressions are caught in CI, not by chaos. |

## 8. Finish line

At one pinned master SHA:

1. **500 consecutive restart-crossing task executions** across the sampled
   matrix with **zero R1–R6 failures**. At least 20 of them cross K5 (the long
   outage) and at least 20 cross K6 or K7 (repeat kills).
2. Every K×B cell has at least 5 passes on both Claude and Codex.
3. Two K13 storm hours at concurrency 20 in which every task reaches its
   resting state, and the R3 Retry works on the first click every time.
4. No open P signature remains in the ledger.
5. One staging wave after deploy confirms the result. There, U9 sees no restart
   failure across all restarts in a 24-hour window.

## 9. Cost and safety

- Hard budget per wave (start at $30) and per night (start at $150). The harness
  refuses to start a wave above 80% of the cap.
- The harness signals only processes it started, using the PID and start-time
  checks in `process-tree-owner.ts`. It never touches the default instance or
  any other dev server.
- The Daytona cleanup sweep runs after every wave and on harness exit. Orphaned
  sandboxes are counted as R6 failures before they are deleted.
- No real credentials are placed in fixtures. The canary secret check (soak U7)
  stays on, because recovery paths replay logs.

## 10. Decisions needed from Dotta

1. **Daytona quota and concurrency ceiling:** is 20 concurrent sandboxes OK, or
   is the cap lower?
2. **Budget:** are $30 per wave and $150 per night acceptable caps?
3. **K5 bar (outage longer than the 7-minute reconnect grace):** is a working
   Retry an acceptable outcome, or must the task continue automatically from
   saved work? The plan assumes automatic continuation is required when the
   last provider turn settled, and Retry is acceptable when the turn was in
   flight. This matches the #19399 rule.
4. **Adapters for the finish line:** Claude and Codex native only, or also the
   ACPX adapters?
5. **K12 rolling deploys:** include them now, or wait until zero-downtime web
   deploys (`2026-10-31-zero-downtime-web-deploys.md`) is the production path?
