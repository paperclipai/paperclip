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
pnpm --filter @paperclipai/paperclip-runner run build:runner-binaries   # native runner (debug)
set -a; source ~/.secrets; set +a                                   # provider keys, process env only
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex,claude,opencode --concurrency 4 --tasks 8 --faults K1,K2,K4 --seed 42
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --replay w-20261106T101112-s42/t03
pnpm exec vitest run --config tests/restart-chaos/vitest.config.ts  # credential-free unit tests
node scripts/typecheck-test-projects.mjs tests/restart-chaos        # typecheck
```

Options: `--triggers time,comment,retry,queued,tool,result` (fault timing, below),
`--workloads A1,B1,B5,C1`, `--budget-cents` (company hard cap,
default 3000), `--poll-ms` (2000–5000), `--keep` (keep the temporary instance).

`--rc06-masked` keeps the company budget amount but disables its hard stop on
the isolated Chaos Lab company, so one stuck accounting row (RC-06) cannot
wedge every later task. Masked tasks are marked `rc06-masked` in the ledger and
summary, and each wave still records its spend (`wave_spend` in the timeline).
A replay inherits the masks saved in the source wave's `plan.json`;
`--replay <wave>/<task> --rc06-masked` adds the mask to a replay of an unmasked wave.
Each fault receipt records the host 1-minute load average (`loadAvg1m`); treat
timeout failures above about 16 as load-suspect.

## Restart storm (K13, `--storm-minutes`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex,claude,opencode --concurrency 6 --storm-minutes 60 --seed 7
```

A storm wave fires faults on its own seeded clock instead of one fault per
task. Each fault is drawn from `--faults` (default K1, K2, K4, K6) and fires
2–4 minutes after the previous one settled (server ready), so a K4 hold never
eats the next gap. Each fault hits every task in flight. While the storm lasts
the harness launches a new task whenever one rests, keeping `--concurrency`
in flight; `--tasks` (default 200) is only the pool. A pool that runs dry
before the storm ends fails the wave as a harness error (`storm_pool_exhausted`). When the storm ends no
new task or fault starts, the in-flight tasks drain to rest or their deadline,
and only launched tasks are graded. Storm tasks show fault `K13` in the ledger;
`storm_fault`, `storm_started` and `storm_ended` are in the timeline and the
receipts are in `faults.json`. A replay of a storm task fires the faults that
crossed it, without a new storm. Only `--triggers time` applies.

## Daytona (`--env daytona`)

The control plane stays local; agent runs execute in Daytona sandboxes from an
immutable runner image. No Docker is needed.

```sh
set -a; source ~/.secrets; set +a        # DAYTONA_API_KEY plus provider keys, process env only
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona \
  --daytona-image ghcr.io/paperclipai/paperclip-daytona-runner@sha256:<digest> \
  --adapters codex,claude --tasks 3 --concurrency 2 --faults K1 --seed 11
```

`PAPERCLIP_E2E_DAYTONA_IMAGE` can replace `--daytona-image`. B5 is local-only
(its oracle reads the live workspace, which is inside the sandbox).

**vCPU budget.** The Daytona org is shared with the live Cloud fleet. Chaos
sandboxes use `--daytona-cpu` vCPU (default 4, with 4 GiB memory and 10 GiB
disk), and `--concurrency × --daytona-cpu` must stay within 40 vCPU
(`RESTART_CHAOS_DAYTONA_VCPU_BUDGET`). On a small org, set the budget below the
org limit with room for verification probes: a 10 vCPU org fails creates with
HTTP 400 "Total CPU limit exceeded", so use 8 there and `--daytona-cpu 2`.

**Fleet safety.** The harness never stops, archives or deletes a Daytona
sandbox. Its Daytona client is a frozen wrapper that exposes only a
label-filtered `list`. `assertHarnessMayMutate` refuses `paperclip-create-*`
names (every plugin-created sandbox has one) and `fleet-sbx-*` snapshots, so a
future mutating path cannot act on fleet sandboxes either. Cleanup goes only
through Paperclip, by deleting the wave's own environment.

**Image matching.** The controller needs the image's own Linux amd64
`/usr/local/bin/paperclip-runnerd` (`PAPERCLIP_RUNNER_REMOTE_BINARY_PATH`) and
`/opt/paperclip-runner/provider-pack/` (`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH`).
`daytona-image.ts` gets them without a daemon: `skopeo copy --override-os linux
--override-arch amd64 docker://<image> dir:<cache>`, then walks the layers from
top to bottom (honouring `.wh.` and `.wh..wh..opq` whiteouts), extracts only
those two paths, checks the ELF header, the pack manifest and the image labels,
records their digests in `receipt.json`, and deletes the layer blobs. The result
is cached in `results/daytona-images/<digest>/`, so it runs once per image.
Run it alone with `node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/daytona-image.ts <image>`.

Before starting, the harness compares the image's `io.paperclip.runner.content-id`
label with the content ID of this checkout (`pnpm test:e2e:runner:image-id`,
which hashes every runner input) and refuses to run on a mismatch. To get an
image for the current master, dispatch a narrow image build and reject its paid
gate:

```sh
gh workflow run runner-full-stack-e2e.yml --ref master -f cadence=manual -f all=false \
  -f id=core-compatibility.runner-codex.daytona.message-marker
# when the run waits on the paid environment:
gh api -X POST repos/paperclipai/paperclip/actions/runs/<run>/pending_deployments \
  -F "environment_ids[]=20786721735" -f state=rejected -f comment="Image build only"
```

The digest is in the "Publish verified Daytona image" job log (`pushing manifest
for …@sha256:…`), or check out the image's `org.opencontainers.image.revision`.

**Setup** reuses runner-e2e: the bundled Daytona plugin (`installFixtureDaytonaProvider`,
prepared outside the root workspace as CI does), the `daytona` environment
fixture from `catalog.ts`, and the native Codex platform-qualification probe.

**R6 sweep.** After the wave, `daytona-sweep.ts` lists (read-only) the
sandboxes whose `paperclip-company-id` and `paperclip-environment-id` labels
both equal the UUIDs this wave's isolated instance minted, re-checks every row,
and reconciles them with the environment's leases. It retries for the product's
pending-cleanup backoff plus 90 seconds (6.5 minutes, capped at 8) before
calling anything a leak. A sandbox archived after its
lease was released is expected (the plugin archives on release and Daytona
deletes it after 60 minutes). Any other live sandbox without a held lease, or
an `active`/`pending_cleanup` lease, is a leak: it fails R6 for the
task whose run owns it, or the wave when no task does. The harness then deletes
the wave's environment through Paperclip and lists again: a wave sandbox that
is still neither archived nor destroyed after 90 seconds fails the wave and is
reported for a person to act on (the environment's 60-minute ttl also expires
it). An environment DELETE that returns 409 because a sandbox cleanup is still
pending is retried for the same settle window; if it is still blocked then, the
wave fails (not as a harness error) and the instance is kept, because its
database owns the cleanup work. The result is in `<wave>/sandbox-sweep.json`.

## Fault timing (`--triggers`)

Each task samples one trigger with its cell. `time` (default) fires at the
seeded offset. The others fire relative to a user action or run state seen by
the observer, after a seeded delay:

| Trigger | Fires | Plan |
| --- | --- | --- |
| `comment` | 0–5 s after the C1 follow-up was posted to a live run (C1 only) | C1 + K1, B8 |
| `result` | 0–3 s after the run that received the C1 follow-up proposed or accepted its result, only while that run is still `running` (C1 only) | C1 + K1, B8 |
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
| `observer.ts` | Polls each issue and its runs. When a task rests needing Retry it calls `POST /api/issues/:id/retry` once (once more only if a later fault started after that click), with the body `useTaskRetry.ts` sends. Collects T-oracle artifacts and the R6 sweep. |
| `grader.ts` | Pure R1–R6 grading over the samples. |
| `workloads.ts` | A1 brief document, B1 python CLI with tests, B5 long bench, C1 comment while running, with their T-oracles. |
| `evidence.ts`, `ledger.ts` | Evidence bundle for each failure and the JSONL ledger plus `SUMMARY.md`. |
| `daytona-image.ts` | Docker-free extraction of the image's runnerd and provider pack, cached per digest, and the controller/image content-ID check. |
| `daytona-sweep.ts` | Daytona R6: read-only reconciliation of this wave's labelled sandboxes with leases; cleanup only through Paperclip. |

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
- R4 fails when two runs of the issue executed at the same time: both
  `running` in one sample, or overlapping started→finished windows. A queued
  or scheduled wake behind a running run is not a duplicate unless it starts
  executing. A wake comment may be served again only after a run that did not
  succeed.
- T-oracle commands (B1 tests and CLI) run agent-editable code. They run under
  a macOS Seatbelt sandbox with a scratch `HOME`, no network and no read access
  to the operator's home directory. On other platforms they are refused unless
  `RESTART_CHAOS_ALLOW_UNSANDBOXED_ORACLE=1` is set inside a disposable VM.
- R1 allows the workload budget plus outage time. When a Retry was needed R1 is
  `n/a` and R3 decides; a task that rests unfinished with no Retry fails both.
- Faults are serialized; each one hits every task running at that moment.
- A `todo` or `in_progress` task with no live run and no named wait is not a rest. The observer keeps watching it until it resumes or passes the R5 stall limit.
- R5 also fails a run that stays `running` with no live evidence (no new run event, `lastUsefulActionAt` or `execution.lastConfirmedActivityAt`, and no start) for more than 3 minutes after the server is ready. A `running` status alone is not proof of life. A quiet run is still live while a tool it started has not ended (for example a 4-minute `bench.sh`) or while its recorded local runner process still runs with the same PID and start time.
- The wave fingerprints the checkout and `packages/paperclip-runner/dist` at start and after every fault. A build, install or branch switch during a wave would make later restarts run different code, so it fails the wave as a harness error (`worktree_changed_mid_wave`). Build before the wave, never during it.
- A fault that fails to complete fails the wave as a harness error (exit 2), even when recovery brings the server back.
