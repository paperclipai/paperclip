# Warm follow-up turns: TTFT before and after (Phase 1)

Status: measured 2026-11-07. Follows [`2026-11-07-ttft-baseline.md`](2026-11-07-ttft-baseline.md), finding 1 ("every local turn launches a runner and starts or resumes a provider session") and finding 4 (Claude's resumed `turn.submitted` → `turn.started` gap).

## Summary

- **Warm runners make Codex and OpenCode follow-ups 2.6–5× faster.** Follow-up TTFT p50 drops from 12.0 s to 4.7 s (Codex) and from 21.7 s to 4.2 s (OpenCode). A follow-up is now faster than a new task, which it was not before.
- **Claude does not gain.** Its ACPX runner relaunches the Claude process and reloads the session on every follow-up turn by design, so warm keeps runnerd alive but the follow-up still takes about 10.7 s. Claude stays per-turn by default.
- **Restart recovery is not slower with warm.** K1 and K2 recovery latency is equal or lower, and every interrupted run recovered.
- **The default is now warm for local Codex and OpenCode** agents that never chose a lifecycle, with the 5-minute idle window. Explicit choices and admitted sessions keep their policy.
- **Two defects blocked warm and are fixed:** warm follow-ups kept the first run's completion contract (#19874; every OpenCode warm follow-up looped until timeout), and an idle warm runner whose controller crashed could live up to its 1-hour connection lease (now a 7-minute reconnect grace).

## Method

- Driver: [`tests/restart-chaos/ttft-baseline.ts`](../../tests/restart-chaos/ttft-baseline.ts) with the new `--lifecycle per_turn|warm` option, which sets `lifecycleMode` on every seeded agent. Same method and metric definitions as the baseline: run log only (`run.performance.span`, `run.startup.reuse`, `native.recovery.transition`), nothing from Telemetry.
- Command (per lifecycle): `node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/ttft-baseline.ts --adapters codex,claude,opencode --samples 6 --restarts 3 --lifecycle <per_turn|warm>`.
- Waves:
  - **per_turn** (`m1-per_turn`): revision `bbcda2a10d` (#19852 sub-spans, before its launch-boundary fix).
  - **warm** (`m2-warm`): revision `44baa078d7` = master `4d5265fe7e` + #19874 + the reconnect grace.
  - A first warm wave (`m1-warm`) found the completion-contract defect: 4 of 4 OpenCode follow-ups looped for the 8-minute driver timeout. Its Codex and Claude numbers agree with `m2-warm`.
- Host: Apple M5 Max, 18 cores, 128 GB, macOS, shared with other agent worktrees (1-minute load average 13–27). Dev-mode server. Models are the runner-e2e profiles (`gpt-6.1-sol`, `claude-sonnet-5`, `openrouter/deepseek/deepseek-v4-flash-0731`). Every task is a one-line reply, so TTFT is dominated by startup.
- "Follow-up" is the baseline's `warm` phase: a comment on the same finished task, which reuses the provider session. n = 6 per cell.

## Time to first token (local, p50 / p95)

| Adapter | Start | per_turn TTFT | warm TTFT | per_turn boot | warm boot |
|---|---|---|---|---|---|
| codex | new task | 7.96 / 9.66 s | 4.98 / 7.09 s | 3.42 / 5.60 s | 2.34 / 3.77 s |
| codex | **follow-up** | **12.03 / 17.06 s** | **4.68 / 5.19 s** | 6.25 / 9.54 s | 1.33 / 1.65 s |
| opencode | new task | 12.73 / 24.95 s | 14.16 / 32.93 s | 9.53 / 18.48 s | 8.48 / 14.26 s |
| opencode | **follow-up** | **21.68 / 40.97 s** | **4.16 / 7.43 s** | 17.25 / 34.22 s | 1.40 / 5.21 s |
| claude | new task | 14.16 / 21.75 s | 11.37 / 14.43 s | 9.07 / 15.28 s | 5.57 / 8.86 s |
| claude | **follow-up** | **10.54 / 28.57 s** | **10.72 / 25.55 s** | 4.67 / 18.18 s | 5.85 / 21.39 s |

A new task is cold in both lifecycles (a new provider session), so its differences are host noise.

### Where a per_turn follow-up spends its time (p50)

| Adapter | Runner launch + provider restore | `turn.submitted` → `turn.started` |
|---|---|---|
| codex | 4.21 s | 1.52 s |
| opencode | 16.32 s | 0.49 s |
| claude | 3.53 s | 3.83 s |

This wave predates the #19852 boundary fix, so `runner.process.launch` still includes the provider restore inside `run.attach`. The process spawn itself is 0.2–0.4 s on a new task. With warm, the attach on the live runner takes 0.8–1.0 s (Codex, OpenCode) and `turn.submitted` → `turn.started` 0.6–0.7 s.

## Restart recovery (local, fault ready → next provider event)

| Adapter | Fault | per_turn p50 / p95 | warm p50 / p95 |
|---|---|---|---|
| codex | K1 | 2.70 / 4.11 s | 2.28 / 2.95 s |
| codex | K2 | 3.13 / 4.43 s | 2.19 / 2.27 s |
| opencode | K1 | 9.90 / 13.42 s | 8.72 / 11.75 s |
| opencode | K2 | 10.66 / 12.69 s | 8.20 / 8.54 s |
| claude | K1 | 3.81 / 7.52 s | 3.40 / 5.83 s |
| claude | K2 | 5.29 / 7.05 s | 2.70 / 3.54 s |

n = 3 per cell. Every interrupted run had a recovery transition and a later provider event. The harness's K1 kills the controller's whole process tree, runner included, so these samples resume a dead runner in both lifecycles. The case K1 cannot produce, a controller that dies alone while a warm runner is idle, is covered by the reconnect grace below.

## Restart chaos (R1–R6)

Two waves of the restart chaos harness with the same plan, differing only in the forced lifecycle:

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local --adapters codex,opencode \
  --concurrency 4 --tasks 8 --faults K1,K2,K6 --seed 4242 --rc06-masked --lifecycle <warm|per_turn>
```

| Wave | Lifecycle | Tasks | Crossed a fault | R1–R6 + T-oracle | Open signatures |
|---|---|---|---|---|---|
| `w-20261107T181913-s4242` | warm | 8 | 7 | 8/8 PASS | none |
| `w-20261107T183435-s4242` | per_turn | 8 | 8 | 8/8 PASS | none |
| `w-20261107T194407-s4242` | default (no stored lifecycle) | 8 | 7 | 8/8 PASS | none |

All three waves cover Codex and OpenCode in workloads A1, B1 and B5 under K1 (SIGKILL), K2 (SIGTERM) and K6 (crash loop). Warm adds no R1–R6 failure. The `default` wave ran this pull request's own revision with `--lifecycle default`, which creates the agents without a stored lifecycle, so it exercises the real default path rather than a forced warm. Revision: master `4d5265fe7e` + #19874 + the reconnect grace (#19879, before its recovery follow-up), with `--lifecycle` added to the harness here. The runner-e2e catalog pins `per_turn`, so the harness forces the lifecycle explicitly; warm is what the new default resolves to for these local agents.

### End-to-end default check

`--lifecycle default` on this pull request's revision (`ttft-baseline.ts --adapters codex,opencode --samples 2 --phases coldwarm --lifecycle default`): both agents read back with no stored lifecycle (`agentLifecycles: unset`), and every follow-up reused the runner and provider session (`run.startup.reuse` runner and provider_session `reused`, no `runner.process.launch`). Follow-up TTFT: Codex 4.8 s and 3.6 s, OpenCode 4.1 s and 3.7 s.

This check found that `normalizePaperclipRunnerAdapterConfig`, which runs on every create and update, wrote `lifecycleMode: "per_turn"` into every native config. Without the fix in this pull request, the default never applied and any edit after the migration would have written the old default back.

## Safety model of the warm default

- **Scope.** Only local targets, only `codex_app_server` and `opencode_server`, only agents with no stored `lifecycleMode`. Remote sandboxes need a reusable lease for warm and stay per-turn. Managed providers without warm support stay per-turn.
- **Upgrade.** A session keeps the lifecycle policy it was admitted with (`persistedPolicy`), so a session admitted per-turn before this change stays per-turn. Existing agents keep their stored value.
- **Bounded idle.** The controller's idle timer suspends the session after 5 minutes. Then the runner exits and the instance's idle-work probe reports no work, so instance sleep is delayed by at most the idle window.
- **Ownership.** A warm runner follows the same attach, reattach and fence rules as a per-turn runner. A graceful controller shutdown suspends idle warm sessions first. A controller that dies without suspending them leaves the runner disconnected; after 7 minutes (`localRunnerProcessReconnectGraceMs`, the remote grace) runnerd proves no controller re-authenticated, stops its provider, keeps its durable state for a cold resume, and exits. Before this change that bound was the 1-hour connection lease.

## Finding 4: Claude's resumed `turn.submitted` → `turn.started` gap

The cause is ours, not the provider's. The ACPX session reaps the sidecar and Claude process at the start of every turn after the first, then resumes the same persistent session in a fresh process generation (`acpx_provider_session.rs`, `restart_idle_provider`). The documented reason: the MCP endpoint is session-lifetime and cannot tell which provider turn sent a late HTTP callback. On a resumed session the sidecar also defers provider initialization to the first prompt (`acpx-runtime-sidecar.ts`, `await runtimeTurn.promptStarted`). Both land between `turn.submitted` and `turn.started`: 3.8 s p50 per_turn, 2.75 s warm.

A warm runner does not avoid it. `run.attach` checkpoints the ACPX sidecar and the next `session.open` starts a new process generation and loads the session (about 5 s of the warm follow-up's attach), and that resumed generation still defers its provider initialization to the first prompt (2.75 s). The relaunch itself is required: the old generation must be reaped before its call-ID tombstones are released. What can change is when it happens. Preparing the next generation while the session is idle, after the previous turn settles, would take it off the follow-up's critical path. That is a runnerd change with its own late-callback proof and timing receipts. Until then Claude stays per-turn by default.

## Gaps

- Small samples (n = 6 TTFT, n = 3 per fault) on a loaded shared host; p95 values carry machine load.
- Daytona and other remote targets were not measured; the default does not change them.
- The per_turn and warm waves ran at different revisions (sub-span boundary fix in between), so compare the sub-step rows only within a wave.
