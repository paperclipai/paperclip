# Restart chaos harness (Phase 1 MVP)

Plan: [`doc/plans/2026-11-06-control-plane-restart-chaos.md`](../../doc/plans/2026-11-06-control-plane-restart-chaos.md).

A script, not an LLM. It starts an isolated Paperclip control plane (temporary
`PAPERCLIP_HOME`, wrapper-owned embedded Postgres, its own port), seeds a
"Chaos Lab" company, launches real agent tasks, kills or restarts the control
plane during those tasks, and grades every task on R1–R6 plus a deterministic
T-oracle.

## Run

```sh
pnpm install --frozen-lockfile
pnpm --filter @paperclipai/paperclip-runner build:runner-binaries   # native runner (debug)
set -a; source ~/.secrets; set +a                                   # provider keys, process env only
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex,claude,opencode --concurrency 4 --tasks 8 --faults K1,K2,K4 --seed 42
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --replay w-20261106T101112-s42/t03
pnpm exec vitest run --config tests/restart-chaos/vitest.config.ts  # credential-free unit tests
node scripts/typecheck-test-projects.mjs tests/restart-chaos        # typecheck
```

Options: `--triggers time,comment,retry,queued,tool` (fault timing, below),
`--workloads A1,B1,B5,C1`, `--budget-cents` (company hard cap,
default 3000), `--poll-ms` (2000–5000), `--keep` (keep the temporary instance).
`--env daytona` is reserved; it fails until the Daytona image and environment
are wired (see the TODO in `seed.ts`).

## Fault timing (`--triggers`)

Each task samples one trigger with its cell. `time` (default) fires at the
seeded offset. The others fire relative to a user action or run state seen by
the observer, after a seeded delay:

| Trigger | Fires | Plan |
| --- | --- | --- |
| `comment` | 0–5 s after the C1 follow-up was posted to a live run (C1 only) | C1 + K1, B8 |
| `retry` | 0–2 s after an accepted Retry click, as an extra K1 after the planned fault | K8 |
| `queued` | on the first poll whose run is still `queued` with no start | B1 |
| `tool` | 15–60 s after `bench.sh` progress first appears (B5 only) | B6 |

A trigger whose condition can no longer hold (comment posted at rest, run
already started, no Retry offered) is recorded as `triggerMissed` in the
ledger; the task is still graded. `--faults K6` is the crash loop: after the
first kill, the replacement is killed again as soon as `/api/ready` reports
`recovering` (or `ready`, if recovery was too quick to see), and once more just
after `ready`. The receipt's `crashLoop` lists the phase each kill hit. A replay
re-arms the task's own triggered faults instead of using their offsets.

## Pieces

| File | Role |
| --- | --- |
| `supervisor.ts` | Owns the server. Reuses `tests/runner-e2e` process code (config, ports, env isolation, wrapper-owned Postgres, process-tree stopper, `replaceController`). Faults: K1 SIGKILL + immediate restart, K2 SIGTERM + restart, K4 SIGKILL + 2–5 min hold, K6 crash loop. The controller runtime cache is kept (discarding it is K11). |
| `seed.ts` | Chaos Lab company, encrypted provider secrets, native Codex / ACPX Claude / OpenCode agents from the runner-e2e catalog, and the `chaos-sandbox` project (git repo: python CLI, one failing test, `bench.sh` ≈ 4 min) with isolated git-worktree workspaces. It first turns on the instance `enableIsolatedWorkspaces` setting; without it the server ignores the project policy and every repo task shares the primary checkout. |
| `scheduler.ts` | Seeded plan: workload × adapter × fault cells and a random fire time per task. Saved to `results/<wave>/plan.json`. `--replay` reruns one task alone with the same choices and fires the recorded sequence of faults that crossed it (other tasks' faults included) at the same offsets from launch. |
| `observer.ts` | Polls each issue and its runs. When a task rests needing Retry it calls `POST /api/issues/:id/retry` once, with the body `useTaskRetry.ts` sends. Collects T-oracle artifacts and the R6 sweep. |
| `grader.ts` | Pure R1–R6 grading over the samples. |
| `workloads.ts` | A1 brief document, B1 python CLI with tests, B5 long bench, C1 comment while running, with their T-oracles. |
| `evidence.ts`, `ledger.ts` | Evidence bundle for each failure and the JSONL ledger plus `SUMMARY.md`. |

## Output (gitignored)

`tests/restart-chaos/results/` (override with `RESTART_CHAOS_RESULTS_DIR`):

- `ledger.jsonl`, `SUMMARY.md` — every graded task, per-cell pass rate, open signatures.
- `<wave>/plan.json`, `timeline.jsonl`, `server.log`, `faults.json`, `<task>.grade.json`.
- `<wave>/evidence/<task>/` on failure — run ids and statuses, last 200 events per
  run, workspace operations, server log window around each fault, startup phase
  timings, fault timeline, seed, git SHA and the replay command. Known provider
  key values are redacted.

## Grading notes

- A task is restart-crossing when a run overlaps a fault window or the task was
  not yet at rest when the fault started. Non-crossing tasks are still graded.
- R2 also checks that workspace files present before the first fault still exist at rest.
- B5 passes only when `bench.sh` wrote its own completion record showing it
  ran, and the harness itself saw at least three `.bench/progress` values
  while polling. This is best-effort against a deliberately adversarial agent.
- R4 allows at most one active (queued, running or scheduled-retry) run per
  sample. A wake comment may be served again only after a run that did not
  succeed.
- T-oracle commands (B1 tests and CLI) run agent-editable code. They run under
  a macOS Seatbelt sandbox with a scratch `HOME`, no network and no read access
  to the operator's home directory. On other platforms they are refused unless
  `RESTART_CHAOS_ALLOW_UNSANDBOXED_ORACLE=1` is set inside a disposable VM.
- R1 allows the workload budget plus outage time. When a Retry was needed R1 is
  `n/a` and R3 decides; a task that rests unfinished with no Retry fails both.
- Faults are serialized; each one hits every task running at that moment.
- A `todo` or `in_progress` task with no live run and no named wait is not a rest. The observer keeps watching it until it resumes or passes the R5 stall limit.
- A fault that fails to complete fails the wave as a harness error (exit 2), even when recovery brings the server back.
