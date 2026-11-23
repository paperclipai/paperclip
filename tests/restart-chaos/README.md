# Restart chaos harness (Phase 1 MVP)

Plan: [`doc/plans/2026-11-06-control-plane-restart-chaos.md`](../../doc/plans/2026-11-06-control-plane-restart-chaos.md).

A script, not an LLM. It starts an isolated Paperclip control plane (temporary
`PAPERCLIP_HOME`, wrapper-owned embedded Postgres, its own port), seeds a
"Chaos Lab" company, launches real agent tasks, kills or restarts the control
plane during those tasks, and grades every task on R1–R6 plus a deterministic
T-oracle.

This file covers running the harness, its modes, how tasks are graded, and its
output. Each workload and fault scenario, with its command and oracle, is in
[SCENARIOS.md](SCENARIOS.md). Add a note about one scenario there, not here.

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
`--workloads A1,B1,B5,C1` (opt-in: G1, H1, L1, R1, S1, W2, W2Q, W2C), `--db-pressure <writers>` ([SCENARIOS.md](SCENARIOS.md#database-contention-l1---db-pressure)), `--budget-cents` (company hard cap,
default 3000), `--poll-ms` (2000–5000), `--keep` (keep the temporary instance),
`--k4-hold-max-seconds` (raise the seeded K4 hold upper end from 300 s, up to the 600 s outage cap).
`--faults K0` plans cells with no fault, for workloads whose shape is the fault (W2, in [SCENARIOS.md](SCENARIOS.md#re-wake-after-success-w2-w2q-w2c)). `--fail-recovery-step`,
`--long-turn-minutes`, `--k15-overlap-seconds`, `--k15-fresh-home`, `--ephemeral-server`, `--runner-bind-fault`, `--workload staging-mix` and `--release-swap` are described in their own sections.
`--fault-after-seconds <n>` fires every planned fault `n` seconds after its task launches (5–3600; with `--triggers time`), keeping
the rest of the seeded plan, for example to restart a Daytona R1 task after its workspace preparation.
`--matrix` crosses every selected workload with every fault kind ([SCENARIOS.md](SCENARIOS.md#journey--fault-matrix---matrix)), and `--server-from <dir>`
runs every server of the wave from another prepared checkout, for example a commit before a fix.

Each wave's temporary instance (embedded Postgres, workspaces, often 5–13 GB) is
deleted when the wave ends, pass or fail, including after an interrupt. Evidence
is already copied into `results/`. Use `--keep` to inspect the instance itself.
A kept instance, or one whose processes could not be stopped, gets a
`.paperclip-runner-e2e-kept.json` marker; creating the next runner E2E or chaos instance removes marked instances older
than 6 hours whose Postgres is no longer running and that no live process still
references. An instance whose Daytona cleanup is still pending keeps its database
as the owner of that cleanup and never expires. Unmarked directories are never
removed.

`--rc06-masked` keeps the company budget amount but disables its hard stop on
the isolated Chaos Lab company, so one stuck accounting row (RC-06) cannot
wedge every later task. Masked tasks are marked `rc06-masked` in the ledger and
summary, and each wave still records its spend (`wave_spend` in the timeline).
A replay inherits the masks saved in the source wave's `plan.json`;
`--replay <wave>/<task> --rc06-masked` adds the mask to a replay of an unmasked wave.
Each fault receipt records the host 1-minute load average (`loadAvg1m`); treat
timeout failures above about 16 as load-suspect.

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
| `asked` | 0–3 s after the saved question or tool review is first seen pending (Q1–Q3) | journeys |
| `answered` | 0–3 s after the board's answer or approval returned (Q1–Q3) | journeys |

A trigger whose condition can no longer hold (comment posted at rest, run
already started, no Retry offered) is recorded as `triggerMissed` in the
ledger; the task is still graded. `--faults K6` is the crash loop: after the
first kill, the replacement is killed again as soon as `/api/ready` reports
`recovering` (or `ready`, if recovery was too quick to see), and once more just
after `ready`. The receipt's `crashLoop` lists the phase each kill hit. A replay
re-arms the task's own triggered faults instead of using their offsets.

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

**Fleet safety.** The Daytona org is shared with the live Cloud fleet, and
every plugin-created sandbox, the fleet's included, is named
`paperclip-create-*`. The name therefore says nothing about who owns a
sandbox; the labels do. Each wave's isolated instance mints a fresh company
and environment UUID, and the Daytona plugin labels every sandbox it creates
with both. Cleanup first deletes the wave's own environment through Paperclip.
Then it deletes every sandbox that still carries both of this wave's labels
(archived setup sandboxes included, since Daytona does not delete archived
sandboxes on its own), and nothing else: the listing is filtered by both labels
on the server and checked again on every row, and `assertHarnessMayMutate`
refuses any sandbox without both labels and any `fleet-sbx-*` snapshot. The
only delete is `DELETE /sandbox/<id>` for a row that passed those checks. A
wave sandbox still there after the settle window fails the wave
(`undeletedSandboxes`, and the warm-shutdown verdict).

**Image matching.** The controller needs the image's own Linux amd64
`/usr/local/bin/paperclip-runnerd` (`PAPERCLIP_RUNNER_REMOTE_BINARY_PATH`) and
`/opt/paperclip-runner/provider-pack/` (`PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH`).
`daytona-image.ts` gets them without a daemon: `skopeo copy --override-os linux
--override-arch amd64 docker://<image> dir:<cache>`, then walks the layers from
top to bottom (honouring `.wh.` and `.wh..wh..opq` whiteouts), extracts only
those two paths, checks the ELF header, the pack manifest and the image labels,
records their digests in `receipt.json`, and deletes the layer blobs. The result
is cached in `tests/restart-chaos/results/daytona-images/<digest>/` (or
`$RESTART_CHAOS_IMAGE_CACHE`), shared by every wave and crash-point run, so it
runs once per image. A copy that fails part-way, or stalls past its 20-minute bound
(`RESTART_CHAOS_SKOPEO_ATTEMPT_TIMEOUT_MS`), retries from an empty directory.
Run it alone with `node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/daytona-image.ts <image>`.

**Provider-pack mismatch.** Because the controller takes its pack from the
same image the sandboxes start from, the preinstalled pack always verifies and
the upload path (`provider_pack.select` with `stateSource: uploaded`, reason
`cached_packs_unverified`) and its session admission never run. Staging runs
there whenever a deploy is newer than the sandbox image. `--daytona-pack-mismatch
<registry/repository@sha256:…>` starts every sandbox from that other image (an
older runner image) while the controller keeps `--daytona-image`'s runnerd and
pack. Every fresh sandbox then uploads and verifies the controller's pack, and
the session must record its admission before artifact retention. Pass: every
task finishes with no Retry and no run ends with
`native_provider_artifacts_admission_unverified`. The timeline records
`daytona_pack_mismatch`.

Before starting, the harness compares the image's `io.paperclip.runner.content-id`
label with the content ID of this checkout (`pnpm test:e2e:runner:image-id`,
which hashes every runner input) and refuses to run on a mismatch. For a local
test of a branch that changes only controller-side TypeScript, set
`PAPERCLIP_CHAOS_TEST_ACCEPT_IMAGE_CONTENT_ID` to the image's exact content ID
to run against that existing image; the harness prints a `TEST OVERRIDE` warning
and the timeline keeps both content IDs. Such a wave is not image qualification. To get an
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

The harness also requires the image's provider pack to be the one a named
commit built: the commit in the image's `io.paperclip.runner.source-revision`
label, or, when the image has no such label, the image's own
`org.opencontainers.image.revision`. An image that copied its Runner names
the commit that built it in that label; an image that built its own Runner
has none. An empty label counts as absent, because an image can empty a label
of its base but cannot drop it.

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

**Clean warm shutdown.** Every warm wave (`--daytona-warm` or `--lifecycle warm`)
also grades "no leaked sandboxes / clean warm shutdown" (`warm-shutdown.ts`). It fails
the wave when the environment delete stayed blocked, when a wave sandbox is still
running after cleanup, or when the server log shows a warm session that did not close
on environment delete or controller shutdown. Idle closes that needed a forced Runner
stop, or whose sandbox was already destroyed, are counted but do not fail. Both counts
are distinct (run, reason) failures, not log lines: the harness's environment-delete
retries re-log the same failed close every few seconds (one session logged 27 times in
w-20261116T001158-s7106). Each failure keeps its line count. On a Daytona warm wave, the
first idle-close failure in the server output triggers one sandbox capture
(`daytona-runner/idle-close-failure-<run>/`: processes, Runner state and logs), listed
under `sandboxCaptures`. The result is in `<wave>/warm-shutdown.json` and in the wave's
`SUMMARY.md`.

## Hosted mode (`--hosted-base-url`, `--hosted-allow`)

```sh
set -a; source ~/.secrets; set +a
H=<name>.staging.paperclip.app
# Read-only: watch one release of the instance (GET /api/health every 2 s) and report its shape. No writes.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/hosted.ts --hosted-base-url https://$H --hosted-allow $H --hosted-observe-only
# Smoke: 2 tasks, no release wait, 1-minute settle, then cleanup.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/hosted.ts --hosted-base-url https://$H --hosted-allow $H \
  --hosted-releases 0 --hosted-tasks 2 --hosted-turn-minutes 3 --hosted-label rc-hosted-smoke1
# A run across 3 real releases at 5 concurrent (default), then the same at 15.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/hosted.ts --hosted-base-url https://$H --hosted-allow $H --hosted-releases 3 --hosted-label rc-hosted-r3c5
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/hosted.ts --hosted-base-url https://$H --hosted-allow $H --hosted-releases 3 --hosted-concurrency 15 --hosted-label rc-hosted-r3c15
# Remove everything one run created (also run automatically at the end of every run unless --hosted-keep).
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/hosted.ts --hosted-base-url https://$H --hosted-allow $H --hosted-cleanup-only --hosted-label rc-hosted-r3c5
```

Hosted mode runs the release-swap proof against a real hosted instance that takes automatic releases, instead of
servers the harness starts. It starts no server and injects no fault: each release the instance's own continuous
deploy rolls out is a swap.

**Target guard** (`hosted-guard.ts`). The harness refuses to start unless `--hosted-base-url` is a bare `https://`
origin and `--hosted-allow` names the same host. The host must be one stack under `.staging.paperclip.app` or
`.test.paperclip.app`. `paperclip.staging.paperclip.app`, production hosts, the fleet admin and Cloud hosts are
refused even when allowed explicitly. Every request is checked against that one origin before it is sent.

**Sign-in.** The harness uses a board token for the host: `PAPERCLIP_HOSTED_TOKEN`, or
`credentials["https://<host>"].token` in `~/.paperclip/auth.json` (the CLI's store). It never prints the token.
Hosted stacks sit behind the Cloud tenant gateway, which answers every request without a session, including
`/api/health` and the CLI's `POST /api/cli-auth/challenges`, with `401 tenant_session_required`. So
`paperclipai auth login --api-base https://<host>` cannot start there. A person who can sign in to the instance must
create the challenge from a signed-in browser tab, approve it, and store the token. Without a token, hosted mode
stops before any request.

**Setup** (`hosted-setup.ts`). Company creation is managed by Cloud, so the run works inside the signed-in user's
company (`--hosted-company <id>` when there are several). Everything it creates carries the run label
(`--hosted-label`, default `rc-hosted-<UTC minute>`): one project `Restart chaos <label>`, one agent per adapter
`RC <label> <adapter>`, and one company secret per provider key, `restart-chaos <label> <KEY>`. The keys come from
the harness's own environment (source `~/.secrets` first) and go to the instance only through its secrets API. The
default mix is OpenCode only (`--hosted-ratio opencode=100`, DeepSeek through OpenRouter), so the only stored key is
`OPENROUTER_API_KEY`; adding `codex` or `claude` to the ratio also stores `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`.
The agents use the company's one sandbox environment (`--hosted-environment <id>` when there are several), the
warm Runner lifecycle, and `maxConcurrentRuns` split by the ratio. `results/hosted-<label>/hosted-state.json` keeps
the ids.

**Workload** (`hosted-workload.ts`). Staging-mix tasks (`staging-mix.ts`): rounds of a foreground tool command for
the seeded turn length (`--hosted-turn-minutes`, default 5–15), parents with two subtasks (`--hosted-subtask-share`,
default 30%), and board follow-up comments during a run (`--hosted-follow-up-share`, default 50%). The harness keeps
`--hosted-concurrency` tasks (default 5, at most 30) in flight. A task stops counting as in flight when it is done,
cancelled, blocked or in review, or has had no live run for 10 minutes. Grading is hands-off: the harness never
clicks Retry during the wave or the settle period. It records, per task, when a Retry banner first showed and whether
it cleared by itself. `--hosted-retry-during-wave` restores the old behavior of clicking an offered Retry at once. Tasks keep arriving until the `--hosted-releases`-th release (default 3)
is detected, then the run waits for it to settle. `--hosted-releases 0` runs a fixed batch (`--hosted-tasks`) with no
release wait, for a smoke. `--hosted-max-hours` (default 8) bounds the wait.

**Release detection** (`hosted-release.ts`). A probe reads `/api/health` every `--hosted-health-seconds` (default 2)
and records each answer's `serverInfo.processStartedAt` and `commit`. A new process identity is a release. For each
release the report gives:

- the window in which two process identities answered (the overlap);
- the failed and slow (2 s or more) health requests from the last answer of the old build only until 60 s after the
  window;
- the time to the first answer from the new build;
- whether the commit changed.

A release is `overlap` when both builds answered and no request failed, and `stop_then_start` when requests failed
before the new build answered. `--hosted-observe-only` does only this, read-only, for `--hosted-releases` releases
(default 1), and writes the table to `SUMMARY.md`.

**Grade** (`hosted-grade.ts`, `hosted-readers.ts`). After the last release, the settle period (`--hosted-settle-minutes`,
default 15) and a bounded drain (`--hosted-drain-minutes`), every started task of the run's agents is graded once
with `gradeReleaseSwapTask` and `summarizeGrades` from `release-swap-grade.ts`, the same module as RS1. After the
settle period the harness clicks Retry once on each task that is not done and offers it, and records whether it
worked. A task that completed with no click passes. `SUMMARY.md` starts with three numbers:
`<pass> / <started> tasks completed hands-off`, `Retry banner shown: <n>` and `Retry worked / clicked: <w> / <c>`.
The next line gives the instance's assigned-work invariant (`GET /api/companies/:id/assigned-work-invariant`), read
once: the company's violation counts by clause and agents with stalled slots, and the sampled violations and stalled
slots that belong to this run. Builds without the endpoint answer 404, and the line says the invariant is not
available. Each failing task
carries one label: `nothing pending`, `blocked for a non-person reason` or `needed Retry` (with whether the click
worked). Retry is clicked through the API where the board offers it, as in RS1. Everything RS1 reads from Postgres
comes from the API here: runs from `/api/companies/:id/heartbeat-runs`, tasks from the issue list filtered to the
run's agents, the task view from `/api/issues/:id`, pending questions and approvals from the task's interactions and
approvals, failure chains and next events from `/api/heartbeat-runs/:id/events`, and duplicated comments and
subtasks from comments and the issue list. Per release the table counts failed runs and the time from the old
build's last answer to each surviving run's next event. Web and API continuity are reported for both the health
probe and every API request the harness made, counted separately: requests, failures, slow answers and the longest
gap between successful answers. Every request, cleanup included, is saved at the end of every mode with its time, method, path
with ids replaced by `:id`, status, duration, and whether it was a health probe. A run writes `requests.jsonl`;
`--hosted-cleanup-only` and `--hosted-observe-only` write their own `requests-<mode>-<time>.jsonl`, so a later call never
replaces a run's records. The summary breaks failures down by status and by
inside or outside a release window (from the old build's last answer to 60 s after the new build answers). A health probe fails unless `/api/health` answers 200 with a readable body. An API request fails
on no answer, a server error, or 401, 403, 408 or 429; a deliberate 400, 404, 409 or 422 answer is not a failure. Runs come from the company run list, or from every task's
run list when that list is full, so no task's early runs are lost. A queued or running run with no activity for 5
minutes is not a live owner, the same window the drain uses. The drain also waits for the 90 s quiet period
(`--hosted-quiet-seconds`), and the grade reads runs and task views again immediately before grading. The drain cap
counts from the later of the last release and the end of arrivals, so a run that stops launching at `--hosted-max-hours`
long after its last release still drains for `--hosted-drain-minutes`. Run activity is aged from the moment the grade
read the runs, not from after the task view reads. A task that is still open, has no failed run, and whose every live run is still queued
behind its agent's full `maxConcurrentRuns` cap, with the queue-wait proof finding no idle slot and no newer
assignment run started ahead of it, is not graded: `SUMMARY.md` names it on a `Not graded` line and
`hosted-release-swap.json` lists it under `notGraded`. The runs holding the slots are still graded.

**Gate D verdict** (`hosted-gate.ts`). A run exits 0 only when every check in the `Gate D` block of `SUMMARY.md` holds:
every started task completed hands-off; every task the harness launched was created; every started task passes the local waves'
R1 (`gradeR1` from `grader.ts`); no Retry banner was shown; no health probe failed; no overlapping runs, duplicated
agent comments or duplicated subtasks; no release was stop-then-start; and at least one release was detected, each
with a live run carried across it. A fixed batch (`--hosted-releases 0`) skips the release check. R1 uses the
staging-mix budget (`stagingMixBudgetMs`); a subtask the agent created under a launched task is graded from its own creation time with the
budget of its two rounds. It adds outage time only for a release whose health probes failed
before the new build answered. It credits the first run's queue wait when the agent's slots prove it fair
(`queueWaitFairnessFrom`, from the run list and each agent's `runtimeConfig.heartbeat.maxConcurrentRuns`). The API
has no wake evidence, so a follow-up run's queue wait is never credited. Per-release hand-off and reach are API
proxies: runs alive at the old build's last answer, and how many of them wrote an event after it. The server log's
`handed live native runs` and `reattach phase ended` lines are not readable through the tenant API.

These fields are unavailable over the API and are reported as unavailable, not guessed:

| Field | Why |
| --- | --- |
| queued wakes | no API read of a task's queued wake requests; a task resting only on a queued wake grades as having no owner |
| owning server process of a run, and runs lost while the old server was alive | the API does not expose a run's controller boot |
| double executors | needs database cross-server evidence |
| late start on the old server, preparation during recovery | the harness does not drive the release, so it cannot place probes on the outgoing server |

**Cleanup.** At the end of every run (unless `--hosted-keep`), and with `--hosted-cleanup-only --hosted-label <label>`:
pause the run's agents, cancel their queued and running runs (which releases their sandboxes), archive (hide) their
tasks, terminate and remove the agents (an agent with cost history stays terminated, as the product requires), delete
the run's secrets, and archive its project. A setup that fails part-way is cleaned up from `hosted-state.json`. Only objects whose name carries the
label are touched.

## Universal checks (U1–U5)

Every task of every wave is also graded on five scenario-independent rules (`universal.ts`), whatever
its workload. They catch a stuck or misleading task that no scenario anticipated.

| Rule | Fails when | Bound (env override) |
| --- | --- | --- |
| U1 liveness | a non-terminal task has neither a live owner (a running run with recent evidence, a run queued within the queue bound, a scheduled retry, an accepted Retry that waits on the system within the queue bound, a system recovery action) nor a visible, actionable item (Retry, a question or `userAction`, a failed notice, a board recovery action, an execution blocker, `blocked` or `in_review`; none of these count while an accepted Retry waits on the system) for longer than the bound, counting only time with the server ready | 3 min ownerless (`RESTART_CHAOS_U1_ORPHAN_SECONDS`); a queued run or an accepted Retry's wait counts as an owner for 5 min (`RESTART_CHAOS_U1_QUEUED_SECONDS`) |
| U2 retry loop | more than N consecutive failed runs with the same status and code while the issue status stays the same | 3 (`RESTART_CHAOS_U2_SAME_FAILURE_RUNS`) |
| U3 diagnosable | a failed run has no code or a generic one (`adapter_failed`, `unknown`, `error`, ...) and no recorded `failureCause` (a bounded code such as `40001`, `exit_code_137` or `provider_http_429`; a bare `Error` or `unknown_error` does not count), its stored error is empty or names only a bare cause (`last cause: Error`), or a recovery action's cause or next action is empty or bare | none |
| U4 stale notice | a Retry or failed notice stays on a task after its latest run succeeded, longer than the bound or at rest | 60 s (`RESTART_CHAOS_U4_STALE_SECONDS`) |
| U5 run budget | one task created more runs than the bound | 10 (`RESTART_CHAOS_U5_MAX_RUNS`) |

When the workload declares a queue (staging-mix `--mix-queue` above 0), a run that waits queued while its agent's
`maxConcurrentRuns` slots are all taken is a healthy queued run. U1 then allows it the declared queue bound,
ceil(queue / runs) × (longest turn + 5 min); for L1 (20 runs, 20 queued, 12–22 minute turns) that is 27 minutes.
Only queued time with a free slot of its agent counts toward the 5-minute queue bound, so a run left queued while
its agent has a free slot still fails. Slot use comes from `wake-evidence/agent-slots.json` (every run's start and
finish and each agent's effective cap as the server computes it, `maxConcurrentRunsSql`, so a configured 100 is saved
as the server's limit of 50; captured at wave end). Without that file (older waves) only the declared bound applies.

A parent whose turn ended `yielded` or `blocked` and that waits, with no run, until its subtasks complete is in a
named wait (`waitingOnChildren`): R5 and U1 do not count it as a stall. The observer keeps watching such a parent
while any subtask is open. When an older record rested during that wait and the parent then completed through its
`issue_children_completed` wake, grading takes the completion from the wake evidence.

U1, U2, U4 and U5 fail the task (signature `U<n>:...`). U3 is a warning: it is reported in each grade
(`grade.universal`), the ledger (`universal`, `universalWarnings`) and the wave's `SUMMARY.md`, and
never fails a task. U3 reads run error text and recovery-action causes from the wave database at
wave end, because the board's run list hides most error text.

The rules and bounds come from an audit of the saved evidence of 79 waves (1,620 tasks, 1,483 of
them passing R1–R6 and T; 30 waves where every task passed), run with:

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/universal-audit.ts <results dir> [...]
```

| Rule | Flagged tasks | On passing tasks | On all-pass waves |
| --- | --- | --- | --- |
| U1 | 17 | 0 | 0 |
| U2 | 1 | 0 | 0 |
| U3 | 30 | 3 | 0 |
| U4 | 0 | 0 | 0 |

U5 came later, from the 2026-11-11 `response_wake` self-wake loop: a yielded run with
`continuation.kind: "response_wake"` and no admitted response source enqueued an immediate
`issue_status_changed` wake to the same agent, so W2/W2C tasks ran 30 to 66 times ~12 s apart.
Over the saved waves, passing tasks outside that loop created at most 5 runs, and some looping
tasks still passed every other rule. A task with more than 10 runs now fails as
`U5:run_budget_exceeded`.

On passing tasks the longest ownerless stretch was 19 s, the longest queue wait 136 s (p99 40 s),
the longest accepted-Retry wait 278 s, and no failure repeated more than twice; with the 3-minute
ownerless clock on top, a queued run or a Retry wait is flagged after 8 minutes. U1 flags a C1 task that sat 181 s in `todo` with a resolved interruption (it also failed
R5), and six R1 tasks in three waves whose run stayed `queued` for 8 minutes while the issue still
showed a retry row, which those waves graded only as a late R1. A retry row counts as a live timer
only until its run is dispatched. It also flags ten tasks whose accepted Retry waited on the system
for 8 minutes without starting a run (five in saved waves, five in the [L1 waves](SCENARIOS.md#database-contention-l1---db-pressure)). U2 flags a claude task that failed four times in a
row with `adapter_failed`. Every U3
flag is `adapter_failed`, including three tasks that passed after a retry, which is why U3 stays a
warning until `adapter_failed` names its cause. Runs now record that cause as `failureCause` (shown
by the board's run list), and U3 accepts it; saved waves from before the field show none, so U3
remains a warning until fresh waves show it holds. The audit saw only failure codes; the error-text
part of U3 is checked only in waves run with this harness.

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
  A task that never rested within its deadline fails R1 as `no_rest_within_budget`,
  whatever its last status. R1 also allows fair queue waits of runs that new
  input started, chosen by these rules in order:
  1. If any run on the task has no `createdAt`, nothing is credited.
  2. The first run (earliest `createdAt`) is a candidate unless it is a retry.
  3. For each harness follow-up comment: without a send time, nothing is
     credited for it. Otherwise the candidate is the earliest run that carries
     the comment, was created at or after the send time, and was not cancelled
     before it executed.
  4. That run counts only if it is not a retry, the previous executed run
     succeeded and finished before it was created, and
     `wake-evidence/<task>.json` shows a comment wake reason and no continued
     run (no wake evidence: nothing is credited).
  5. Each candidate's wait, from `createdAt` to `startedAt` inside the task's
     own lifetime and minus outage time, is credited only when
     `wake-evidence/agent-slots.json` proves it fair: no newer fresh assignment
     run of that agent started during the wait (newer follow-ups and retries
     rank higher by design), and the agent had no idle slot for more than 2 s
     outside a server outage. A provably unfair wait fails as
     `unfair_queue_wait`; one that cannot be proven is not credited, and the R1
     detail says why.
  The observer holds the deadline while a candidate run is queued (up to one
  more budget) and extends it by that run's wait once it starts.
- Speed: an aggregate p50/p95 row can breach only with at least 5 samples; a
  smaller row is reported as `insufficient sample (n < 5)`. Every cold or warm run
  over its p95 budget, and every restart recovery whose Paperclip share exceeds
  its p95 budget, still fails the wave on its own. `speed.json` keeps each graded
  run's own split (`runs`): `bootMs` (Paperclip: claim to the provider accepting
  the turn), `providerFirstActivityMs` (turn accepted to first visible activity),
  and the spans before the turn, so a breach stays attributable after the
  temporary instance is deleted.
- Faults are serialized; each one hits every task running at that moment.
- A `todo` or `in_progress` task with no live run and no named wait is not a rest. The observer keeps watching it until it resumes or passes the R5 stall limit.
- R5 also fails a run that stays `running` with no live evidence (no new run event, `lastUsefulActionAt` or `execution.lastConfirmedActivityAt`, and no start) for more than 3 minutes after the server is ready. A `running` status alone is not proof of life. A quiet run is still live while a tool it started has not ended (for example a 4-minute `bench.sh`) or while its recorded local runner process still runs with the same PID and start time. While a provider turn is active and no tool runs, one model request is outstanding: R5 allows up to 10 minutes of quiet before it counts a dead run. A slow OpenRouter request took 303.6 s in w-20261115T044649-s7106/t028, and common provider clients time out a request at 10 minutes. A run with no run event yet (`preparing`: its events read back empty) is still acquiring or preparing its environment, because "run started" is written only after that. R5 allows it 10 minutes too: in w-20261116T001158-s7106/t010 a Daytona restore of an archived sandbox took 251 s, including one 90 s plugin call timeout, and the Daytona provider bounds each start or restore at 5 minutes by default, so 10 minutes covers one timed-out restore and its retry. U1 uses the same bounds before it stops counting a running run as the task's owner: `PREPARATION_LIMIT_MS` for a preparing run and `PROVIDER_TURN_LIMIT_MS` while a provider turn is active. In w-20261117T084017-s7106/t001 one OpenCode model request stayed quiet for 7.5 minutes before the agent called `paperclip_finish`, while the API kept the run `running` and the task `working`.
- The wave fingerprints the checkout and `packages/paperclip-runner/dist` at start and after every fault. A build, install or branch switch during a wave would make later restarts run different code, so it fails the wave as a harness error (`worktree_changed_mid_wave`). The baseline is taken after the harness's own setup (preflight rebuilds provider entrypoints) and covers the tracked diff, untracked file contents, the runner `dist` and the runnerd binary. Build before the wave, never during it.
- `faults.json` and `task-faults.json` (each task's launch time and the faults that crossed it) are written after every fault, so `--replay` of a task in an interrupted or wedged wave, or a storm task, re-fires the faults that crossed it at the same offsets.
- A fault that fails to complete fails the wave as a harness error (exit 2), even when recovery brings the server back.

## Pieces

| File | Role |
| --- | --- |
| `supervisor.ts` | Owns the server. Reuses `tests/runner-e2e` process code (config, ports, env isolation, wrapper-owned Postgres, process-tree stopper, `replaceController`). Faults: K1 SIGKILL + immediate restart, K2 SIGTERM + restart, K4 SIGKILL + 2–5 min hold, K6 crash loop, RR1–RR3 repeated restarts. The controller runtime cache is kept (discarding it is K11). |
| `seed.ts` | Chaos Lab company, encrypted provider secrets, native Codex / ACPX Claude / OpenCode agents from the runner-e2e catalog, and the `chaos-sandbox` project (git repo: python CLI, one failing test, `bench.sh` ≈ 4 min) with isolated git-worktree workspaces. It first turns on the instance `enableIsolatedWorkspaces` setting; without it the server ignores the project policy and every repo task shares the primary checkout. |
| `scheduler.ts` | Seeded plan: workload × adapter × fault cells and a random fire time per task. Saved to `results/<wave>/plan.json`. `--replay` reruns one task alone with the same choices and fires the recorded sequence of faults that crossed it (other tasks' faults included) at the same offsets from launch. |
| `observer.ts` | Polls each issue and its runs. When a task rests needing Retry it calls `POST /api/issues/:id/retry` once (once more only if a later fault started after that click), with the body `useTaskRetry.ts` sends. Collects T-oracle artifacts and the R6 sweep. |
| `config-faults.ts`, `config-wave.ts` | Config faults: the reference catalog, seeded plan and oracle (pure), and the wave runner that breaks, restarts, repairs and grades. |
| `grader.ts` | Pure R1–R6 grading over the samples, plus the universal checks. |
| `universal.ts`, `universal-audit.ts` | U1–U4 on every task, and their audit over saved waves. |
| `contention.ts` | L1 workload, its accounting oracle and the `--db-pressure` writers. |
| `workloads.ts` | A1 brief document, B1 python CLI with tests, B5 long bench, C1 comment while running, M1 delegation, G1 approval across a restart, H1 budget hard stop across a restart, F1 absolute symlink kept in the workspace, T1 long shell tool, H2 hand-off to a person, with their T-oracles. |
| `journeys.ts`, `journey-driver.ts`, `journey-oauth-app.ts`, `journey-matrix.ts` | Q2 and Q3 definitions and oracles, the board's side of each, Q3's loopback OAuth/MCP app, and the `--matrix` planner. |
| `evidence.ts`, `ledger.ts` | Evidence bundle for each failure and the JSONL ledger plus `SUMMARY.md`. |
| `daytona-image.ts` | Docker-free extraction of the image's runnerd and provider pack, cached per digest, and the controller/image content-ID check. |
| `disk-full-faults.ts` | DF1: the control file for the server's test-only disk-full hook, the rest evidence, and the `disk_full_fault` check and R3 rule. |
| `provider-faults.ts`, `provider-shim/` | PV1–PV3: the resolve hook, the Codex stdio shim, per-task rules and the `provider_fault_applied` check. |
| `acpx-provider-faults.ts`, `provider-shim/acpx-*` | PV1–PV3 for Claude (ACPX): the stand-in runner package, the server hook, the sidecar/provider tap, and `--provider-fault-restart`. |
| `question-handoff.ts` | Q1 saved question: the board's answer step and its oracle. |
| `time-faults.ts`, `time-faults-config.ts` | TM1–TM3: process freezing, database aging with recorded rows, and the time-corrected API the grader reads through. |
| `multi-server.ts` | MS1–MS3: the second server's steps, the seeded holds, and the cross-server invariant over the wave database. |
| `repeated-restarts.ts` | RR1–RR3: seeded restart steps, `--rr-gap-seconds`, and the stop-and-replace loop the supervisor runs. |
| `redeploy.ts`, `redeploy-preload.mjs` | K15: per-generation emulated host name and Railway deployment identity, the preload that applies the host name, and `--k15-hold-seconds`. |
| `daytona-runner-logs.ts` | K15 on Daytona: read-only capture of each wave sandbox's Runner stderr log, identity, state and process, memory and OOM evidence. |
| `daytona-sweep.ts` | Daytona R6: read-only reconciliation of this wave's labelled sandboxes with leases; cleanup only through Paperclip. |
| `staging-mix.ts`, `staging-mix-run.ts` | `--workload staging-mix`: options, the seeded plan (adapters, arrivals, fault slots), the SM task and its oracle, the follow-up and Retry step with the overlap probe, the arrival gate and the resource guard. |
| `hosted.ts`, `hosted-*.ts` | Hosted mode (entry point `hosted.ts`): target guard, authenticated API client and health probe, release detection, API-backed grade readers, setup and cleanup, workload driver and entry point. |

## Output (gitignored)

`tests/restart-chaos/results/` (override with `RESTART_CHAOS_RESULTS_DIR`):

- `ledger.jsonl`, `SUMMARY.md` — every graded task, per-cell pass rate, open signatures.
- `<wave>/plan.json`, `timeline.jsonl`, `server.log`, `faults.json`, `<task>.grade.json`.
- `<wave>/evidence/<task>/` on failure — run ids and statuses, each run's events (all of them, or the first 400
  and the last 200 with an `omittedEvents` marker between, so the wake payload and `turn.submitted` are always
  kept), workspace operations, server log window around each fault, startup phase timings, fault timeline, seed,
  git SHA and the replay command. Known provider key values are redacted.
- `<wave>/wake-evidence/<task>.json` for every task, read from the wave database before the instance is deleted.
  It holds:
  - each run's `context_snapshot`, invocation source and trigger;
  - the `agent_wakeup_requests` row behind each run and every wake for the issue: reason, source, trigger detail,
    requesting actor, idempotency key, payload and times;
  - the issue's status changes from the activity log: only `issue.*` entries whose status is an issue status, so a
    `runner.api_called` entry with an HTTP status is not mistaken for one.

  Each wake and run also names the server generations alive when it was created (`servingAtCreate`): the pid, boot
  id, epoch and process space from `controller_instances`, and the harness's own primary or secondary role during an
  overlap. The run's owning controller is listed as `owner`. `wake-evidence/servers.json` lists every controller and
  harness server window.

  - **Process exit:** a controller's lifetime also ends at the process exit the harness recorded, so a hard-killed
    server is not listed as serving later work.
  - **Aged waves:** in TM2/TM3 waves, the database times are put back at their real times before they are compared
    with the harness clock.
  - **Failed waves:** the capture also runs, once, on the failure path before PostgreSQL stops. If the task list does
    not exist yet, it writes one `issue-<id>.json` per issue that has runs.

## Crash-point suite (`scripts/crash-points.mjs`)

Plan: [durable ownership, "Testing: enumerate crash points"](../../doc/plans/2026-11-07-durable-ownership-and-reconciliation.md).
Random waves find a 20 ms–1 s window between two durable writes by luck. The
crash-point suite kills the control plane at each named window on purpose.

```sh
set -a; source ~/.secrets; set +a           # provider keys, process env only
node scripts/crash-points.mjs --list                                   # selected points, kinds, invariants
node scripts/crash-points.mjs --points 'runner.*,native.*' --adapters codex --workloads A1
node scripts/crash-points.mjs --kinds wake_request_claimed --nth 2
```

Options: `--points <glob,...>` (`*`, `?`), `--kinds <ownable kind id,...>`
(ids from `server/src/services/recovery/ownership-registry.ts`), `--adapters`
(default `codex`), `--workloads` (default `A1`), `--nth` (fire at the nth hit,
default 1), `--env local|daytona` (a point runs only in the environments its
registry entry lists), plus `--daytona-image`, `--daytona-cpu`, `--budget-cents`,
`--poll-ms`, `--lifecycle` and `--keep`, passed to each wave.

The suite runs one wave, `main.ts --crash-point <a>:<nth>,<b>:<nth>,...`:

1. One isolated control plane boots once, with `PAPERCLIP_CRASH_POINT_CONTROL`
   set to an empty control file (nothing armed) and without the Vite UI.
2. For each point in turn: invariants are read as a baseline, the harness
   arms the point by writing `<token> <name>:<nth>` to the control file, and
   the point's batch launches (one task per adapter × workload). Creating an
   assigned issue already queues its wake, so the point is armed first.
3. At the nth hit the server appends a receipt and SIGKILLs itself. The
   supervisor treats it as K1: it empties the control file, kills what is
   left of the server's process tree, starts a replacement, and waits for ready.
4. When the batch rests, the point is disarmed. `invariants.ts` runs the
   Phase 1 report-only reconciler against the wave's database
   (`record: false`), and the point is charged only with violations that are
   new since its baseline:
   - two passes at the real clock for I1 (owned) and I2 (settled);
   - one pass with the clock moved 15 minutes ahead for I3 (admission), I4
     (exactly-once intents) and I7 (visible next action).
   Each violation carries its wake and run state as evidence. Two run-log
   checks complete the set:
   - I6: a run that failed on a stale-generation event. Since #19960 an
     earlier generation's event is history and must never fail the current
     turn.
   - I8: every `run.performance.budget_exceeded` event the speed budgets
     wrote (TTFT, agent boot, restart recovery).
   I5 (work-based budgets) is a known gap: charge decisions are not recorded
   per restart claim, so the suite cannot tell a charged restart from an
   uncharged one. R3 bounds it (no point may need a Retry).
5. Every task is graded R1–R6 and T at the end, as in any wave.

The first full local run (14 points, codex A1) took 11.8 minutes: one boot,
then about 40–60 seconds per point. One point alone takes about 3 minutes,
boot included.

Limits: the server kills itself without warning, so there is no pre-fault
workspace snapshot and R2 checks workspace failures but not lost files
(`notMeasured` in `crash-point.json`). `--replay` of a crash-point task fires
the recorded K1 restart at its offset instead of re-arming the point; to
reproduce a point, rerun the suite for it.

Results: `results/crash-points/<run>/SUMMARY.md` and `summary.json`, plus the
wave directory with `crash-point.json` (per point: receipt, task grades,
violations with evidence). Outcomes: `pass`, `fail` (a task failed R1–R6/T or an invariant was
violated, or the wave exited 1 for a wave-level reason such as a Daytona
sandbox left after cleanup), `not_reached` (the chosen workloads never crossed the point: pick a
workload or `--nth` that does) and `harness_error`. Exit code 0, 1, 3 and 2.

**Daytona points.** Six points are reachable only with `--env daytona`
(`node scripts/crash-points.mjs --list --env daytona`). The run needs
`DAYTONA_API_KEY` and an image matching this checkout (`--daytona-image` or
`PAPERCLIP_E2E_DAYTONA_IMAGE`; see "Daytona" above), and refuses to start
without them. A plain codex task reaches both `sandbox.create.*` points and
both `environment.teardown.*` points (a native run releases its sandbox through
teardown). `environment.lease_release.after_provider_before_lease` (the plain
release path) and `environment.stop_retain.after_claim_before_stop` (a
stop-and-retain export) were not reached by any workload on 2026-11-08; a
`not_reached` result prints what each needs.

`environment.stop_retain.after_claim_before_stop` needs `--daytona-reuse-lease`:
the chaos environment then keeps reusable sandboxes, so each per-turn run stops
and keeps its sandbox.

**CI.** `.github/workflows/crash-points.yml` runs the same command on demand
(`workflow_dispatch`, inputs `points`, `kinds`, `adapters`, `workloads`, `nth`).
It is not a required PR check. It runs only from the default branch, for
allowlisted actors, in the `runner-e2e-paid` environment, and uploads summaries
and grades only (no server logs).

### Add a crash point

1. Add an entry to `packages/shared/src/crash-point-registry.ts`. Name it
   `<subsystem>.<record>.<before|after>_<step>` after the gap it marks, for
   example `sandbox.create.after_provider_before_lease`. Give a description of
   what is durable and what is not at that instant, the environments that reach
   it, the ownable kind ids it affects and the invariants at risk.
2. Call `crashPoint("<name>")` at the gap: after the first durable write (or
   outside effect) returns and before the next one starts. Server code imports
   `crashPoint` from `@paperclipai/shared/crash-points`. Controller code in
   `packages/paperclip-runner` uses `src/crash-point.ts` (add the name to its
   union too). Do not put a point inside a transaction; the gap is between
   commits.
3. `server/src/__tests__/crash-point-call-sites.test.ts` fails until every
   registered point has a call site and every kind id exists.
4. Run the point: `node scripts/crash-points.mjs --points <name>`. A
   `not_reached` result means the workload never crosses it.

**Fail mode.** A control-file line may end in `fail` (`<token> <name>:<nth> fail`): the nth hit then
throws once instead of killing the server. An optional `pid=<n>` binds the line to one server process. A call site can name the error its real step throws
(`crashPoint("<name>", { fail: () => conflict("...") })`). `--fail-recovery-step` uses it.

Disarmed, a point costs one comparison (about 4 ns), and the arming variables
(`PAPERCLIP_CRASH_POINT`, `PAPERCLIP_CRASH_POINT_CONTROL`) are ignored under
`NODE_ENV=production`, so points may sit on the path before `turn.start`.
In-process tests use `armCrashPointForTest("<name>:<nth>")`, which throws
`CrashPointReached` at the hit instead of killing the test runner.
