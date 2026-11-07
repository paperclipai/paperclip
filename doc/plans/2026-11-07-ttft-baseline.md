# TTFT, boot and restart-recovery baseline (Phase 0)

Status: Phase 0 deliverable B, 2026-11-07. Phase 1 sets p50/p95 budgets from these numbers (plan, "Performance constraint", rule 4).
Plan: [`2026-11-07-durable-ownership-and-reconciliation.md`](2026-11-07-durable-ownership-and-reconciliation.md) (#19831). Companion: [`2026-11-07-ownership-inventory.md`](2026-11-07-ownership-inventory.md).

## Summary

- **Runner launch and provider session start dominate TTFT.** Core work before dispatch (queue plus prepare) takes about 0.6 s at p50 and up to 4 s at p95. Starting the runner and the provider session takes 1.6–9.4 s at p50 (cold) and up to 50 s at p95. The cause: `lifecycleMode: per_turn` is the product default (`server/src/services/agent-runner-selection.ts:101`), so every turn, even a follow-up, launches a new runner and then bootstraps or resumes the provider session. The run log has 101 `native.process_start_requested` rows across the 96 runs in the data set: 78 measured turns plus 18 restart runs. Every run launched at least one runner process.
- **A follow-up turn is not faster than a new task.**
  - codex: 8.1 s against 5.0 s (TTFT p50);
  - opencode: 21.8 s against 14.3 s;
  - claude: faster (7.7 s against 13.6 s), but it waits 3.7 s between `turn.submitted` and `turn.started`.

  Session resume (`runner.session.resume`) has the worst p95 of any pre-turn step: 48.7 s. Keeping a live runner and provider session between turns (plan rule 2) is the largest TTFT lever this baseline found.
- **Control-plane restart: 13–30 s to ready, then 5–21 s to the next provider event.** Of the restart, `recovering` → `ready` takes 0.3–1.7 s. Process boot takes the rest (a dev-mode `tsx` server with UI middleware; production boot was not measured). After ready, the recovered run's next provider event arrives in 5–6.5 s for codex, 8–18.5 s for claude and 17.6–32 s for opencode (p50–p95, run 4). The overnight chaos evidence shows longer tails, 40–150 s at p95. On Daytona, `awaiting_evidence` recoveries take 33–43 s, which is consistent with the 60 s remote controller lease that only age releases (inventory: `remoteLeaseFenced`, "Record kinds from the zero-downtime upgrade work").
- **Remote paths were not measured.** Code reading found larger waits before `turn.start` on remote paths:
  - a full workspace capture and upload on a first remote run;
  - a sandbox resume loop of up to 60 s;
  - a remote runner identity poll of up to 20 s.

  They are in the table below and need a Daytona baseline in Phase 1.

## Method

- **Source of truth:** the run log only. The data is the `run.performance.span`, `run.startup.reuse` and `native.recovery.transition` rows in `heartbeat_run_events`, read through `GET /api/heartbeat-runs/:id/events`. Nothing was read from Telemetry (AGENTS.md §5.7).
- **Driver:** [`tests/restart-chaos/ttft-baseline.ts`](../../tests/restart-chaos/ttft-baseline.ts) starts one isolated control plane with the chaos supervisor: a temporary `PAPERCLIP_HOME`, an embedded Postgres owned by the wrapper, and the debug native runner. It seeds the Chaos Lab and then, per adapter:
  - **cold:** a new task (a fresh provider session);
  - **warm:** a follow-up comment on the same finished task (the provider session is reused);
  - **restart:** a task inside a `sleep 75` tool call when the control plane is killed with `K1` (SIGKILL) or stopped with `K2` (SIGTERM).

  [`ttft-baseline-stats.ts`](../../tests/restart-chaos/ttft-baseline-stats.ts) computes every number below. Its unit tests are in `ttft-baseline-stats.test.ts`. To reproduce:

  ```sh
  set -a; source ~/.secrets; set +a
  node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/ttft-baseline.ts --adapters codex,claude,opencode --samples 6 --restarts 3
  node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/ttft-baseline.ts --report tests/restart-chaos/results/<wave>/baseline-data.json
  ```
- **Revision:** `origin/master` `f2d8a51027`, plus #19838 (the TTFT anchor, since merged as `e2d490c61b`). Runs 1 and 3 had #19838 applied, so TTFT carries its `anchor` attribute. Run 4 measured restart recovery only.
- **Host:** Apple M5 Max, 18 cores, 128 GB, macOS. The adapters run in parallel, one task per adapter at a time. The host also ran other agent worktrees, so the p95 tails include machine load.
- **Models:** the runner-e2e profiles. These are `runner-codex` (`gpt-6.1-sol`), `runner-acpx-claude` (`claude-sonnet-5`) and `runner-opencode` (`openrouter/deepseek/deepseek-v4-flash-0731`). Every task is a one-line reply, so TTFT is dominated by startup, not by generation.
- **Environment:** local only. Daytona was not measured fresh. The Daytona credential is present, but a Daytona wave needs an immutable runner image whose content matches this controller (`assertControllerMatchesImage` in `tests/restart-chaos/daytona-image.ts`). No such image exists for this revision, and building and qualifying one costs more than Phase 0 allows. The driver also seeds only `--env local` today. Daytona restart recovery comes from the overnight chaos evidence (below), with that evidence's bias.

### Metric definitions

| Metric | Definition (run-log spans) |
|---|---|
| **TTFT** | `task.time_to_first_token`. It runs from the accepted input to the first deliverable text committed by Core. The accepted input is the wake comment, the answered question, or the durable wake request when that is earlier (#19838). Otherwise it is run creation. `anchor` names which one. |
| **Agent boot** | Run claimed (end of `heartbeat.queue`) → provider session accepted `turn.start` (end of `runner.turn.submit`, or of `runner.session.resume` for a resumed session) |
| **Pre-turn steps** | Every span that starts before the turn boundary above, without cumulative wrappers (`task.prepare`, `runner.session.startup`, `environment.startup`) |
| **Restart recovery latency** | Fault `readyAt` (the harness saw `/api/ready` = `ready` and a healthy `/api/liveness`) → the recovered run's next provider event, grouped by `native.recovery.transition.runnerDisposition` |
| **Control-plane restart** | Fault start → `readyAt`, from the supervisor's fault receipt |
| Cold / warm | From `run.startup.reuse` (`layer=provider_session`): `fresh` is cold, `reused` is warm |

## Time to first token and agent boot (local)

Two driver runs combined: run 1 (codex and claude) and run 3 (all three adapters).

| Adapter | Env | Start | n | TTFT p50 | TTFT p95 | Boot p50 | Boot p95 | TTFT anchors |
|---|---|---|---|---|---|---|---|---|
| claude | local | cold | 12/12 | 13.61 s | 24.82 s | 7.20 s | 16.98 s | run_created×12 |
| claude | local | warm | 12/12 | 7.67 s | 23.61 s | 2.88 s | 13.58 s | comment×12 |
| codex | local | cold | 12/12 | 4.97 s | 14.13 s | 2.07 s | 5.63 s | run_created×12 |
| codex | local | warm | 12/12 | 8.10 s | 23.69 s | 3.84 s | 13.60 s | comment×12 |
| opencode | local | cold | 6/6 | 14.28 s | 40.45 s | 9.83 s | 30.77 s | run_created×6 |
| opencode | local | warm | 6/6 | 21.79 s | 73.22 s | 18.02 s | 54.33 s | comment×6 |

### TTFT by stage (p50 / p95)

Each cell is p50 / p95 in seconds. The stages overlap, so they do not sum to TTFT. TTFT also includes the time from the first provider event to the first deliverable text.

| Adapter | Start | Queue | Core prepare | Runner start + session | Submitted → started | Started → first provider event | TTFT |
|---|---|---|---|---|---|---|---|
| claude | cold | 0.1 / 11.1 | 0.5 / 1.9 | 6.4 / 14.8 | 0.1 / 0.2 | 2.3 / 4.0 | 13.6 / 24.8 |
| claude | warm | 0.1 / 1.3 | 0.5 / 2.9 | 2.4 / 10.5 | 3.7 / 8.0 | 1.0 / 1.7 | 7.7 / 23.6 |
| codex | cold | 0.1 / 8.6 | 0.5 / 2.5 | 1.6 / 3.0 | 1.2 / 5.2 | 1.5 / 2.6 | 5.0 / 14.1 |
| codex | warm | 0.1 / 1.1 | 0.5 / 4.1 | 3.3 / 11.8 | 1.0 / 8.6 | 3.1 / 4.9 | 8.1 / 23.7 |
| opencode | cold | 0.1 / 0.7 | 0.5 / 2.1 | 9.4 / 28.5 | 0.9 / 1.2 | 3.3 / 7.7 | 14.3 / 40.4 |
| opencode | warm | 0.1 / 1.1 | 0.6 / 3.9 | 17.4 / 50.2 | 0.6 / 0.8 | 2.9 / 6.1 | 21.8 / 73.2 |

The column spans are `heartbeat.queue`, `task.prepare`, `runner.session.startup` (bootstrap or resume), `runner.turn.submitted_to_started`, `provider.time_to_first_agent_event` and `task.time_to_first_token`. The cold-queue p95 values for claude (11.1 s) and codex (8.6 s) come from one task each: the first task after the server started, which waited for the startup queued-run dispatch pass.

## Slowest steps before `turn.start`

### Measured, ranked by p95

| Pre-turn step | n | p50 | p95 | Adapters |
|---|---|---|---|---|
| `runner.session.resume` | 30 | 3.35 s | 48.66 s | claude, codex, opencode |
| `runner.session.bootstrap` | 48 | 5.79 s | 15.04 s | claude, codex, opencode |
| `heartbeat.prepare_before_environment` | 78 | 0.20 s | 1.40 s | claude, codex, opencode |
| `heartbeat.queue` | 78 | 0.13 s | 1.23 s | claude, codex, opencode |
| `heartbeat.prepare_after_environment` | 78 | 0.28 s | 0.98 s | claude, codex, opencode |
| `comment.to_run_created` | 30 | 0.08 s | 0.65 s | claude, codex, opencode |
| `runner.transport.connect` | 78 | 0.01 s | 0.13 s | claude, codex, opencode |
| `environment.acquire` | 78 | 0.01 s | 0.12 s | claude, codex, opencode |
| `runner.turn.submit` | 48 | 0.03 s | 0.11 s | claude, codex, opencode |
| `native.coordinator.claim` | 78 | 0.01 s | 0.10 s | claude, codex, opencode |
| `environment.workspace.realize` | 78 | 0.01 s | 0.07 s | claude, codex, opencode |
| `skills.prepare` | 78 | 0.00 s | 0.01 s | claude, codex, opencode |
| `runner.prp.route.register` | 78 | 0.00 s | 0.00 s | claude, codex, opencode |

### Found by code reading (from the inventory)

The inventory readers found these waits and writes on the path before `turn.start`. They are not all visible as spans yet.

| Step | Where | Fixed wait or cost | Measured above? |
|---|---|---|---|
| Remote first-run workspace capture and upload | `remote-workspaces.ts:570-572` (`saveRemoteWorkspace(boundary:"initial")`) | A full archive upload before the model starts. This breaks rule 2. | No (remote only) |
| Remote provision commands re-run on each new writer epoch | `remote-workspaces.ts:230, 981` | Up to 300 s per command | No (remote only) |
| Sandbox resume retry loop | `environment-runtime.ts:1814-1851` | Up to 60 s (RPC timeout), backoff 250 ms → 5 s; Kubernetes adds 30 s readiness | No (remote only) |
| Plugin worker-ready poll | `environment-runtime.ts:764-765, 1486-1497` | Up to 5 s at 100 ms | No |
| Obsolete reusable sandbox deletes, inline and serial | `environment-runtime.ts:1766-1771 → 3052` | One provider delete per obsolete lease | No |
| Remote runner identity poll | `native-session-executor.ts:13282-13283` | Up to 20 s at 1 s | No (remote only) |
| Stale remote runner stop | `native-session-executor.ts:6228, 6269-6276` | Up to 10 s at 500 ms | No (remote only) |
| Runtime skill-cache lock | `runtime-skill-cache.ts:121, 134-140` | 20 ms poll up to 60 s, then a failure that needs a manual fix | Inside `skills.prepare` |
| Budget admission | `budgets.ts:1415`, `heartbeat.ts:2937`, wake-queue `postgres.ts:1420/1503` | 3 full exposure evaluations and a locking reservation transaction per dispatch | Inside `heartbeat.prepare_*` |
| Usage recorder start (local adapters) | `usage-receipts.ts:556-560` | 2 directory fsyncs and a probe fsync | Inside `heartbeat.prepare_after_environment` |
| Controller identity | `native-restart-recovery.ts:326-335` → `hot-restart.ts:192` | Uncached. Runs `ps -o lstart` on macOS at every claim, preparation check and renewal. | Inside `native.coordinator.claim` / prepare |
| Legacy controller lease renewal | `legacy-controller-lease.ts:68-73` | One DB round trip per preparation step. A slow DB stalls up to 60 s. | Legacy runs only |
| Successor waits for predecessor cleanup | `heartbeat/queue.ts:1129`, `execution-blocker.ts:70-102` | Unbounded: until the previous run's lease cleanup and finalization finish | In `heartbeat.queue` |

## Restart recovery latency

### Measured by the driver (local)

Run 4 is the source. In it, the driver injected each fault only while every tracked run was inside an open shell tool call, and it checked that again just before the fault. Run 3 had used `sleep 75`, which Claude Code's Bash tool refuses, so run 3's claude samples did not reliably interrupt a tool call and are not used. Run 3's codex and opencode samples agree with run 4 (codex 3.2–5.1 s, opencode 12.5–16.5 s).

| Adapter | Fault | Disposition | n | Recovery p50 | Recovery p95 | No provider event |
|---|---|---|---|---|---|---|
| claude | K1 | resume_dead_runner | 2 | 8.30 s | 18.55 s | 0 |
| claude | K2 | awaiting_runner_reattach | 2 | 12.37 s | 14.55 s | 0 |
| codex | K1 | resume_dead_runner | 2 | 5.06 s | 6.49 s | 0 |
| codex | K2 | awaiting_runner_reattach | 2 | 5.23 s | 5.26 s | 0 |
| opencode | K1 | resume_dead_runner | 2 | 17.64 s | 31.95 s | 0 |
| opencode | K2 | awaiting_runner_reattach | 2 | 21.21 s | 22.38 s | 0 |

Fault → ready:
- run 4 (4 faults): 24.3, 27.6, 29.9 and 27.2 s, at a 1-minute load average of 17–30;
- run 3 (6 faults): 13.2–20.0 s, at a load average of 12–22.

In every fault, `recovering` → `ready` took 0.27–1.7 s. The rest is process boot.

### From the overnight chaos campaign (2026-11-06/07)

These numbers come from the evidence bundles of failed chaos tasks only: 150 bundles and 577 run × fault pairs, at revisions from the campaign. They are biased toward slow and broken recoveries, so use them for tails, not for budgets. K4 includes a 3–5 minute outage hold, and K6 is a crash loop. Rows without a recovery transition or a later provider event are left out.

| Adapter | Env | Fault | Disposition | n (with next event) | Recovery p50 | Recovery p95 | Fault → ready p50 |
|---|---|---|---|---|---|---|---|
| claude | daytona | K1 | `awaiting_evidence` | 1/1 | 33.1 s | 33.1 s | 11.2 s |
| claude | local | K1 | `resume_dead_runner` | 15/21 | 8.8 s | 40.8 s | 22.6 s |
| claude | local | K2 | `awaiting_runner_reattach` | 12/20 | 5.9 s | 78.0 s | 15.2 s |
| claude | local | K4 | `resume_dead_runner` | 2/2 | 3.6 s | 25.9 s | 257.7 s |
| claude | local | K6 | `resume_dead_runner` | 10/10 | 6.2 s | 87.7 s | 42.6 s |
| codex | daytona | K1 | `awaiting_evidence` | 5/6 | 37.1 s | 49.4 s | 11.2 s |
| codex | daytona | K2 | `awaiting_runner_reattach` | 1/1 | 5.1 s | 5.1 s | 14.5 s |
| codex | local | K1 | `resume_dead_runner` | 24/29 | 4.2 s | 113.2 s | 13.6 s |
| codex | local | K2 | `awaiting_runner_reattach` | 19/25 | 4.3 s | 8.1 s | 12.7 s |
| codex | local | K4 | `resume_dead_runner` | 5/6 | 4.2 s | 150.8 s | 230.3 s |
| codex | local | K6 | `resume_dead_runner` | 8/9 | 3.7 s | 13.1 s | 22.0 s |
| opencode | daytona | K1 | `awaiting_evidence` | 1/1 | 42.7 s | 42.7 s | 6.0 s |
| opencode | daytona | K4 | `reattach_remote_runner` | 1/2 | 3.3 s | 3.3 s | 216.5 s |
| opencode | local | K1 | `resume_dead_runner` | 14/15 | 10.9 s | 25.7 s | 10.0 s |
| opencode | local | K2 | `awaiting_runner_reattach` | 16/20 | 12.1 s | 78.0 s | 11.7 s |
| opencode | local | K4 | `resume_dead_runner` | 4/4 | 11.2 s | 15.8 s | 169.8 s |
| opencode | local | K6 | `resume_dead_runner` | 3/5 | 14.4 s | 19.0 s | 21.6 s |

## Turn tail

`task.settle` (provider turn completed → run terminal, including result finalization) takes 0.3–1.8 s at p50 and up to 4.3 s at p95:
- claude: 1.8 s cold, 1.6 s warm (p50);
- codex: 0.7 s cold, 0.9 s warm;
- opencode: 0.5 s cold, 0.3 s warm.

Copyback and sync-out do not appear here, because local runs use the workspace in place.

## Findings, ranked

1. **Every local turn launches a runner and starts or resumes a provider session.** This costs 1.6–17.4 s at p50 and up to 50 s at p95, and it makes follow-up turns slower than new tasks for codex and opencode. Plan rule 2 ("a follow-up turn on a still-valid lease uses what is already there") is not met locally. `lifecycleMode: warm` exists and keeps the runner alive between turns, but it is not the default and this baseline did not measure it. Phase 1 target: measure `warm`, then make the follow-up path reuse a live runner and provider session by default, and add sub-spans for `runner.process.launch`, `runner.runtime.stage` and provider session load, which the local path does not emit today.
2. **Control-plane restart time is almost all process boot.** It takes 13–30 s to ready, with recovery logic at 0.3–1.7 s. A recovered run then waits 5–21 s more for its next provider event (p50, by adapter). Measure production boot, and keep recovery work off the path to `ready`. The inventory found that restart recovery runs a full finalization reconcile before it reattaches runners (`heartbeat/recovery.ts:945-1006`).
3. **Remote recovery waits out a TTL.** On Daytona, `awaiting_evidence` takes 33–43 s, because the remote controller lease (60 s) is released by age, not by a fenced handoff (inventory: section A, `remoteLeaseFenced`).
4. **Claude spends 3.7 s (p50) between `turn.submitted` and `turn.started` on a resumed session**, against 0.1 s on a fresh one. This is provider-side session load, and it is a separate target from runner launch.
5. **Core preparation is not the bottleneck today, but it holds hidden fixed waits.** Queue plus prepare is about 0.6 s at p50. Its p95 tails (1.4 s `heartbeat.prepare_before_environment`, plus 8–11 s for the first task after server start) and the code-reading table show where restart-safety work must not add more:
   - budget admission evaluates exposure 3 times per dispatch;
   - local adapters fsync twice for the usage recorder;
   - an uncached `ps` runs on every claim.

## Gaps in this baseline

- **Daytona was not measured fresh.** See "Method". Phase 1 needs a Daytona baseline before it sets remote budgets.
- **The samples are small.** There are 12 cold and 12 warm samples per adapter for codex and claude (two runs), 6 for opencode, and 2 per adapter and fault kind for restart recovery (run 4). The host was shared, with a 1-minute load average of 9–22, so the p95 values carry machine load.
- **The `wake_request` TTFT anchor never fired here.** The driver's wakes were never deferred or coalesced, so every anchor was `run_created` (new task) or `comment` (follow-up). Deferred-wake latency needs a workload that queues behind a busy issue.
- **No sub-spans exist inside local runner startup.** `runner.session.bootstrap` and `runner.session.resume` cover process launch, staging and the provider handshake together. Finding 1 needs them split.
- **The server ran in dev mode** (`tsx`, Vite middleware). This inflates control-plane boot and probably Core preparation.
- **`lifecycleMode: warm` was not measured.** Every sample uses the product default, `per_turn`.
- **Legacy (non-native) adapters have no TTFT span.** This baseline covers the native runner path only.
