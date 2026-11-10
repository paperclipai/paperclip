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
`--workloads A1,B1,B5,C1` (opt-in: G1, H1, L1, R1, S1), `--db-pressure <writers>` (below), `--budget-cents` (company hard cap,
default 3000), `--poll-ms` (2000–5000), `--keep` (keep the temporary instance),
`--k4-hold-max-seconds` (raise the seeded K4 hold upper end from 300 s, up to the 600 s outage cap).
`--fault-after-seconds <n>` fires every planned fault `n` seconds after its task launches (5–3600; with `--triggers time`), keeping
the rest of the seeded plan, for example to restart a Daytona R1 task after its workspace preparation.
`--matrix` crosses every selected workload with every fault kind (below), and `--server-from <dir>`
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
crossed it, without a new storm. `--triggers time,result` may join a storm: a `result` task (C1) also fires its own K1 or K2 (from `--faults`) just after its run accepts a result, the next storm gap runs from its settle, and no triggered fault fires during the drain. Other triggers do not combine with a storm.

## Governance across restarts (G1, H1)

```sh
# Approval-gated action: the fault fires 0-3 s after the approval appears pending.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex,claude --workloads G1 --faults K1,K2,K4 --triggers approval --concurrency 4 --tasks 6 --seed 31
# Budget hard stop: its own wave, one task at a time.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex,claude --workloads H1 --faults K1,K2,K4 --triggers paused --concurrency 1 --tasks 3 --seed 32
```

**G1.** The agent asks for board approval through its `call_api` tool
(`POST /api/companies/{companyId}/approvals`, type `request_board_approval`,
linked to its task), blocks the task and ends its turn. The `approval` trigger
fires the planned fault once the observer sees the approval pending.

After the restart, with the server ready, the harness acts as the board through
the board's own routes. It either approves (`POST /api/approvals/:id/approve`),
or rejects (`POST /api/approvals/:id/reject`) and cancels the task. The
decision is fixed by the task's nonce, so about half approve and half reject.

On approval, the woken agent creates exactly one backlog subtask named after the
nonce and finishes. The oracle checks these points:

- exactly one approval was requested (a restart that made the agent ask twice fails);
- it was still pending when the board decided after the restart;
- it reached the board's decision;
- the subtask exists exactly once on approval, and never after a rejection.

A rejected task rests `cancelled`; R1 and R3 grade against that status.

**H1.** Before launch, the harness sets the company budget to its observed spend
plus one cent through the board's budget route. The task's first priced usage
then crosses the hard stop mid-run, which pauses the company. The `paused`
trigger fires the fault once the observer sees `paused` with `pauseReason`
`budget`.

After the restart, the pause must hold for 30 s with the server ready. The
harness records every run that started while paused (there must be none), then
resolves the incident with `raise_budget_and_resume` (spend plus 3000 cents).
The task must then finish its brief on its own. H1 pauses the whole company, so
it runs alone (`--workloads H1 --concurrency 1`) and never with `--rc06-masked`.

Neither G1 nor H1 is in the default workloads. The board's actions and what the
observer saw are in the timeline (`governance_*`) and in each task's grade
(`governance`).

## Stop while running, then continue (S1, `--triggers stop`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex,claude --workloads S1 --faults K1,K2,K4 --triggers stop --concurrency 4 --tasks 6 --seed 23
```

S1 is the board's Stop button. While the task's run is running, the harness cancels it through
`POST /api/heartbeat-runs/:id/cancel`. The `stop` trigger fires the fault 0–2 s later. At least
20 s after the stop, once no run is running or queued and no fault is in progress, the harness
comments that it stopped the run on purpose and asks the agent to continue with an extra marker
line. The oracle checks that the stopped run ended `cancelled`, that nothing started between the
stop and the continue comment (recovery must not restart work the operator stopped), and that the
finished brief has both markers. The Stop waits for a ready server with no fault in progress. If the
run already finished when the stop window opens, the harness records a missed Stop
(`task_stop_missed`), skips the stop-triggered fault, still posts the continue comment, and the
oracle checks only the continue. S1 is not a default workload.

## Human-in-the-loop journeys (Q1, Q2, Q3)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex,claude --workloads Q1,Q2,Q3 --faults K1,K2,K4 --triggers asked,answered --concurrency 2 --tasks 4 --seed 41
```

Each journey starts from a user entry point in
[`maps/feature-map/questions-and-approvals.md`](../../maps/feature-map/questions-and-approvals.md).
The harness acts as the board through the routes the board UI uses. It acts only
when the server is ready, no fault is in progress, and every fault the task planned
before the response has fired. Two triggers fire at the journey's own boundaries:

- `asked`: 0–3 s after the observer first sees the saved request pending.
- `answered`: 0–3 s after the board's response returned.

Until the board acts, the task waits on the board, as G1 does: this is not a rest,
not a stall, and gets no Retry. The code lives in `journeys.ts` (definitions and
oracles of Q2 and Q3), `journey-driver.ts` (their board) and `journey-oauth-app.ts` (Q3's app).

**Q1, a question** (`questions`, `continuation`) is the saved question described
under "Provider message faults" below (`question-handoff.ts`). With restart faults
it takes the same two triggers: `asked` arms on its first pending poll and
`answered` on the board's answer. The board answers before an `answered` fault
fires and after every other planned fault.

**Q2, a question on a blocked task** (#20363). The agent asks one single-select
question with its native `request_human_input` tool and ends its turn. The board
reads the card and answers with the option named by the task's nonce (`amber` or
`cobalt`), on the task thread
(`POST /api/issues/:id/interactions/:interactionId/respond`). Before it answers, the board
adds an unassigned `backlog` prerequisite. It sets the task `blocked` by it
(`blockedByIssueIds`), and then answers. The answer must reach the agent in the
bounded answer mode, while the task stays blocked. The agent replies with the
answer marker, in a comment or in that turn's accepted run result (a bounded turn
may report through either). The board waits up to 6 minutes of ready
server for that reply. Then it marks the prerequisite `done`. The
blockers-resolved wake lets the agent write a brief that carries
`ANSWER-<nonce>-<choice>` and finish. The oracle checks these points:

- exactly one question was saved (a restart that made the agent ask twice fails);
- the question was still pending when the board answered;
- with `asked`, the board answered after the restart;
- the brief carries the answer marker and the task rests `done`;
- the reply came while the task was `blocked`;
- the prerequisite relation was kept through the reply;
- the reply came before the prerequisite was finished;
- no run of the task carries `issue_dependencies_blocked`;
- no stale Retry notice at rest.

**Q3, an app action reviewed late** (`tool-review`, #20340). The harness starts its
own OAuth 2.1 + MCP app on loopback. The app has discovery, dynamic client
registration, PKCE, rotating refresh tokens, one-hour access tokens and one write
tool, `create_page`. No third-party account is used. Before launch, the board
connects the app (`POST /api/companies/:id/tools/apps/connect`). It follows the
app's authorize redirect back to `/api/tools/oauth/callback`. Then it finishes setup
for one scripted `process` agent with `create_page` set to Ask first. That agent
is adapted from `tests/e2e/connection-reviews.spec.ts`. Q3 grades the review path,
not a model, so `--adapters` only labels the cell. A process run records usage with no price, so Q3 setup also sets the company budget policy to allow unpriced usage (the amount and hard stop still apply).

The agent's call waits for review. Then the board does three things:

1. It moves that review's saved timestamps and the grant's access-token expiry back
   by 61 minutes in the wave's own database (`shiftReviewClock`); a shared connection keeps that expiry on the connection. This is the
   `GRACE_SHIFT_MS` approach used by `invariants.ts`.
2. It runs **Check connection** (`POST /api/tool-connections/:id/health-check`).
   That check renews the now-expiring token through the app.
3. It approves (`POST /api/tool-gateway/action-requests/:id/approve`).

The oracle checks these points:

- exactly one review was requested;
- the review aged more than an hour;
- the app saw a refresh between the request and the decision;
- the approval was accepted;
- the app saw exactly one `tools/call` with the reviewed title;
- the request ended `executed`;
- the agent reported the provider's one-time receipt, which only the tool result carries;
- the task rests `done`.

## Journey × fault matrix (`--matrix`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads Q1,Q2,Q3 --faults K1,K2,K4 --matrix --concurrency 2 --seed 43
```

`--matrix` plans one task per cell, with a fixed order and a seeded nonce.
The cells are workload × adapter × one of these:

- `K0`: the same journey with no fault, as a baseline;
- each restart fault in `--faults` at each of the workload's own triggers;
- each provider message fault in `--faults` (PV1–PV3), armed once per workload.

For a journey workload, those triggers are `asked` and `answered`. The example
plans 3 × (1 + 3 × 2) = 21 tasks. Any workload can join the matrix, with its own
boundary triggers: G1 at `approval`, H1 at `paused`, S1 at `stop`, C1 at
`comment` and `result`, B5 at `tool`, and the rest at `time` (`WORKLOAD_TRIGGERS`
in `journeys.ts`). G1 and H1 get no baseline, because their oracles grade a board
decision made after a restart. `--fault-after-seconds` pins the time-fired cells.
The matrix sets `--tasks` itself. It does not combine with `--tasks`, `--triggers`,
`--storm-minutes`, `--crash-point` or K14.

A restart hits every task in flight. So the baselines come first, and the wave
never runs a baseline beside a fault cell: fault cells start only after the last
baseline rests.

To prove that a journey fails before a fix, prepare a checkout of the fix's parent.
Then run the same wave against it with `--server-from`. The harness code stays the
same; every server start and restart runs the older build:

```sh
git worktree add --detach ../paperclip-pre20363 3cc1032f6a^ && (cd ../paperclip-pre20363 && node scripts/agent-preflight.mjs)
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local --adapters codex --workloads Q2 \
  --faults K1 --triggers answered --concurrency 1 --tasks 1 --seed 44 --server-from ../paperclip-pre20363
```

## Code change in a real repository (R1, `--workspace-repo`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex,claude --workloads R1,C1 --workspace-repo /path/to/paperclip \
  --faults K1,K2,K4 --concurrency 4 --tasks 8 --seed 22
```

The harness clones the given git repository (shallow, from its committed HEAD)
as the project's workspace, in place of the chaoscli fixture. R1 asks the agent
to add a TypeScript module and a `node:test` file under
`packages/shared/src/chaos/`, named with the task's nonce so concurrent tasks
share the repository without colliding. The oracle runs the agent's test and a
hidden case against its module. B1 and B5 need the chaoscli fixture, so they do
not combine with `--workspace-repo`. Local only.

## Upgrade mid-run (K14, `--upgrade-from`)

```sh
git worktree add ../paperclip-838e9bf3 838e9bf3d2        # an older master build
(cd ../paperclip-838e9bf3 && node scripts/agent-preflight.mjs)
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex,claude --workloads A1,C1,M1 --faults K14 --upgrade-from ../paperclip-838e9bf3 \
  --concurrency 4 --tasks 8 --seed 21
```

The wave's server starts from the older checkout. The first K14 stops it
gracefully (SIGTERM, as a deploy does) and starts this checkout against the same
database, instance directory, port and secrets, so the new build applies its
migrations to the old build's data and resumes what the old build saved. Each
task is graded as usual. Pass means:

- no task needed Retry (R3);
- C1's follow-up comment reached the work (T);
- the wave-end sweep finds no stuck records (R6).

A later K14 in the same wave restarts the current build, like K2. Every K14
receipt names both commits (`upgrade` in `faults.json`, `upgrade_switched` in the
timeline). K14 is local-only, because a Daytona runner must match its image, and
it is never part of a storm's default faults.

## Config faults (CF1–CF3, `config-wave.ts`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/config-wave.ts \
  --faults CF1,CF3 --adapters codex --tasks 4 --concurrency 1 --restarts K1,K2 --seed 61
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/config-wave.ts --faults CF2 --tasks 1 --seed 62
```

A fresh wave only has valid settings. Config faults break one saved setting that refers
to another object. Each task gets its own agent, credential secret and project, so one
task's break never affects another task. The harness breaks the setting through the
board routes a user would use, launches an A1 brief task on that agent and project, and
then checks four things:

1. **Bounded rest.** Within `--park-seconds` (default 420) the task either completes, or
   rests on something that waits for a person: a pending card, an interruption that
   offers Retry or a user action, parked agent setup, or a blocked task. An unstarted
   Queued run counts as a rest only with a card or parked setup that says why it waits.
2. **Actionable message.** While the task rests, the task page names the broken setting:
   the interruption, the execution status, cards, the agent's setup status, or a notice.
   A message that appears only in the run's own error text fails as
   `message_only_in_run_detail`.
3. **No loop, no ownerless queue.** At most 3 runs start while the setting is broken.
   Agent setup does not say it "will retry automatically" while the configuration is
   unchanged. No Queued run sits unstarted for more than 3 minutes without a named wait.
4. **Restart and repair.** A K1 or K2 restart fires while the task rests (`--restarts`,
   alternating), and the task must rest again. The harness then repairs the setting and
   uses the action the task offers: complete the connection card, click Retry, or retry
   the agent's setup. The task must then finish within `--repair-seconds`, and the A1
   brief oracle must pass.

A break that the server refuses on write passes as `refused_on_write`.

| Fault | Setting broken |
| --- | --- |
| CF1 | Project `workspaceStrategy.provisionCommand` set to `bash ./scripts/provision-worktree.sh`, a script that does not exist (as in #20269) |
| CF2 | OpenCode agent `runtimeConfig.aiConnection` selects the responsible user's personal OpenRouter default, which was never created (as in #20361). Repair connects a personal account |
| CF3 | Seeded walk over `provision_command`, `ai_default` (opencode only), `agent_secret` (secret deleted), `workspace_cwd` (path removed), `base_ref` (missing branch), `model_id` (unknown model). Pin a set with `--references` |

Waves are capped at 4 tasks and a concurrency of 2. A wave can contain only one
`ai_default` task, because the product has no route that clears a default once a repair
creates it. Results go to `results/<wave>-cf/` (`SUMMARY.md`, `<task>.config-grade.json`,
`timeline.jsonl`, `server.log`). The instance is deleted when the wave ends.

Settings that CF3 does not break, and why, are listed in `CONFIG_REFERENCES_NOT_BROKEN`
and in every wave summary. CF4 (an instance aged by an older release) is designed in
[`doc/plans/2026-11-09-chaos-config-and-aged-state-faults.md`](../../doc/plans/2026-11-09-chaos-config-and-aged-state-faults.md).

## Cloud storage (`--storage s3`, `--storage-faults`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex,claude --workloads A1,C1 --faults K1,K2 --concurrency 4 --tasks 8 --seed 24 \
  --storage s3 --storage-faults ST1,ST2,ST3
```

`--storage s3` runs the server the way cloud mode does: `PAPERCLIP_STORAGE_PROVIDER=s3`, so run logs
and provider traces use the `s3_segments` backend and attachments, artifacts and other stored files go
to object storage. The store is a loopback MinIO (`RELEASE.2025-04-22T22-12-26Z`, built from source at
`~/.cache/paperclip/tools/minio/minio` or `RESTART_CHAOS_MINIO_BIN`) with its data under the instance
temp root, behind a fault proxy that every server S3 call goes through. The proxy's request counts by
method and status are written to `storage-proxy.json`.

`--storage-faults` adds seeded windows of 60–180 s, alongside the restart faults:

| Fault | Store behaviour during the window |
| --- | --- |
| ST1 | outage: every request answers 503 `ServiceUnavailable` |
| ST2 | slow store: 1–10 s added latency with jitter, and a 2–16 MiB/s bandwidth cap shared by every request in the window (each direction) |
| ST3 | 30% of requests answer 503, half of them `SlowDown` |

`--storage-fault-seconds 15-45` sets the window length range (5–900 s), for example to find how long
an outage a run survives. The windows are logged in the timeline and written to `storage-faults.json`.

With `--env daytona --storage s3`, each task's workspace is a remote workspace: the controller saves
and restores it through the store, so the faults also hit workspace save, restore and copyback. R1
(`--workspace-repo`) runs on Daytona only with `--storage s3`: the project points at the checkout's
GitHub `origin` over https at its `origin/master` commit, so the sandbox clones the repository and its
snapshots are Paperclip-sized. Its oracle reads the task's files through the board API, retrying for up
to 4 minutes while the closing save makes the workspace readable, and runs its commands on a local copy.

Every Retry the grader needs is clicked in the real board UI: the harness opens the issue in a headless
Chromium, waits for the visible Retry button and clicks it. A task whose Retry button is missing fails
R3 as `ui_retry_button_missing (user saw: …)`; a click that sends no retry request fails as
`ui_retry_no_request`. Crash-point waves serve no UI and click Retry through the API.

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
is cached in `tests/restart-chaos/results/daytona-images/<digest>/` (or
`$RESTART_CHAOS_IMAGE_CACHE`), shared by every wave and crash-point run, so it
runs once per image. A copy that fails part-way, or stalls past its 20-minute bound
(`RESTART_CHAOS_SKOPEO_ATTEMPT_TIMEOUT_MS`), retries from an empty directory.
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

## Provider message faults (PV1–PV3) and the saved question (Q1)

```sh
# A Codex governed wait whose interruption terminal arrives 18 s late (PR #20330's boundary).
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads Q1 --faults PV1 --provider-fault-delays 18 --concurrency 1 --tasks 1 --seed 101
# Sweep the window around the 15 s / 30 s deadlines, two tasks at a time.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads Q1 --faults PV1 --provider-fault-delays 5,14,25,29 --concurrency 2 --tasks 4 --seed 102
# The saved question's terminal never arrives during shutdown (PR #20336's boundary).
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads Q1 --faults PV2 --concurrency 1 --tasks 1 --seed 103
```

The third fault family: the provider stays alive, but one protocol message between the runner and the
Codex app-server is late, missing or repeated. `--faults` takes them next to restart faults:

| Fault | The chosen message |
| --- | --- |
| PV1 | is held for the task's delay (`--provider-fault-delays`, seconds, cycled across tasks; default 18) |
| PV2 | is dropped |
| PV3 | is sent twice |

`--provider-fault-message terminal` (default) picks the `turn/completed` notification that follows a
`turn/interrupt`, which a governed wait (a saved question or approval) or a board Stop sends.
`interrupt_ack` picks the response to that `turn/interrupt`. Each rule applies once per task, to the
first matching message. A PV task fires no restart. Provider faults run only with `--env local --adapters
codex`, only with workloads that interrupt a turn (Q1, S1, G1), and not yet in the same wave as restart
faults: a restart kills the shim with any held message. A PV1 task passes `provider_fault_applied` only when
the held message was released; a provider that exited first turned the delay into a drop.

**Seam.** Product code finds the local Codex by resolving the installed `@openai/codex/package.json`.
The harness starts the server with `NODE_OPTIONS=--import provider-shim/codex-resolve-hook.mjs`. That
hook answers only this lookup, with a stand-in package in the instance temp root. The stand-in's
`codex` bin is `provider-shim/codex-shim.mjs`, which starts the real Codex with the same arguments and
relays its JSON-lines stdio unchanged. It changes only the message that the task's rule names. The
hook removes itself from `NODE_OPTIONS`, so the server's children do not load it. The stand-in links the real
platform package, so Codex's sandbox still gets its native executable. A process is bound to a task
when the task's nonce appears in its traffic, such as the prompt or a tool result. Product code is
unchanged, so the same harness can run against an older product commit: copy `tests/restart-chaos`
into a worktree at that commit. Every shim decision is logged in `<wave>/provider-faults.jsonl`. A PV
task also fails `provider_fault_applied` when its fault never happened. A pass where nothing was
injected proves nothing.

Claude is not covered. It runs through the ACPX sidecar against a hash-verified provider pack, and it
speaks ACP, where a cancel has no acknowledgement and the prompt response is the terminal. The
same resolve-hook idea would need a different shim and an integrity exception.

**Q1** asks the agent to save one single-select question with `request_human_input`, end its turn,
and, once answered, write a `brief` containing the board's answer. The harness answers through
`POST /api/issues/:id/interactions/:interactionId/respond`. The nonce fixes the answer as `ALPHA` or
`BRAVO`. The harness answers only after no run of the task is queued or running, so the saved
question must settle on its own first. The oracle checks these points:

- exactly one question was asked;
- the asking run ended `succeeded`;
- no run of the task failed;
- nothing started between the question and the answer;
- the brief carries the answer.

Q1 is not a default workload.

## Database contention (L1, `--db-pressure`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex,claude --workloads L1 --faults K1 --concurrency 4 --tasks 4 --seed 20385 --db-pressure 4
```

Usage receipts and streamed run-log appends update the same `heartbeat_runs` row. In #20385 a
receipt's repeatable-read snapshot went stale when a log append committed between its company check
and its run-row lock; four retries ran out with SQLSTATE 40001, the event stayed in the runner's
retained outbox, and every later terminal event was blocked (`native_event_replay_conflict:
runner_event_commit_stalled ... last cause: Error`).

**L1** asks the agent to run five shell commands as five tool calls, each printing 3,000 lines
(about 300 KB), then save a `brief` naming each command's END line. Each run emits many log
events and many usage reports. L1 is opt-in (not a default workload).

**`--db-pressure <writers>`** (1–8) starts harness-owned writers against the wave's own database.
Each one runs `update heartbeat_runs set updated_at = updated_at` on the wave company's `running`
rows back to back. No value changes, but every statement writes a new row version, which is what a
fast stream does to a run row. Locally the race window between a snapshot and its row lock is well
under a millisecond, so without pressure the race almost never fires; the writers stand in for a
hosted database whose round trip widens that window. The writers stop before the R6 sweep;
`db_pressure_started` / `db_pressure_stopped` (with update and error counts) are in the timeline.

At rest the harness reads each L1 task's runs from the wave database, and the T-oracle adds:

| Check | Fails when |
| --- | --- |
| `no_event_commit_stall` | a run ended `native_event_replay_conflict` or `runner_event_commit_stalled` |
| `usage_receipts_committed_once` | one producer event was journaled twice for a receipt source |
| `terminal_receipts_committed` | a succeeded native run has no terminal (`turn.*`) receipt: its terminal event never left the outbox |
| `finished_runs_accounted` | a finished native run has no `cost_accounted_at` |
| `run_spend_matches_cost_events` | a run's recorded cost differs from its cost events (0.5% or 0.01 cent) |
| `company_spend_settled` | the board's cost summary differs from the cost-event sum, or runs still wait for accounting |
| `contention_produced` | the task produced fewer than 40 log events or 6 receipts (it did not test anything) |

`contention-db.test.ts` checks the knob itself on real PostgreSQL: with four writers, the
pre-#20385 repeatable-read receipt write exhausted its four retries with 40001 in 8 of 8 attempts
locally, and the current READ COMMITTED writer (`persistUsageReceipt`) committed all 8. A live L1
wave needs the runner stall (20 failed deliveries over at least 45 s) to show
`native_event_replay_conflict`; run it against the parent of the #20385 merge (red) and against
master (green) with the command above.

## Universal checks (U1–U4)

Every task of every wave is also graded on four scenario-independent rules (`universal.ts`), whatever
its workload. They catch a stuck or misleading task that no scenario anticipated.

| Rule | Fails when | Bound (env override) |
| --- | --- | --- |
| U1 liveness | a non-terminal task has neither a live owner (a running run with recent evidence, a run queued within the queue bound, a retry timer, a system recovery action) nor a visible, actionable item (Retry, a question or `userAction`, a failed notice, a board recovery action, an execution blocker, `blocked` or `in_review`) for longer than the bound, counting only time with the server ready | 3 min ownerless (`RESTART_CHAOS_U1_ORPHAN_SECONDS`); a run counts as an owner for 5 min of queueing (`RESTART_CHAOS_U1_QUEUED_SECONDS`) |
| U2 retry loop | more than N consecutive failed runs with the same status and code while the issue status stays the same | 3 (`RESTART_CHAOS_U2_SAME_FAILURE_RUNS`) |
| U3 diagnosable | a failed run has no code or a generic one (`adapter_failed`, `unknown`, `error`, ...), its stored error is empty or names only a bare cause (`last cause: Error`), or a recovery action's cause or next action is empty or bare | none |
| U4 stale notice | a Retry or failed notice stays on a task after its latest run succeeded, longer than the bound or at rest | 60 s (`RESTART_CHAOS_U4_STALE_SECONDS`) |

U1, U2 and U4 fail the task (signature `U<n>:...`). U3 is a warning: it is reported in each grade
(`grade.universal`), the ledger (`universal`, `universalWarnings`) and the wave's `SUMMARY.md`, and
never fails a task. U3 reads run error text and recovery-action causes from the wave database at
wave end, because the board's run list hides most error text.

The rules and bounds come from an audit of the saved evidence of 74 waves (1,592 tasks, 1,465 of
them passing R1–R6 and T; 28 waves where every task passed), run with:

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/universal-audit.ts <results dir> [...]
```

| Rule | Flagged tasks | On passing tasks | On all-pass waves |
| --- | --- | --- | --- |
| U1 | 7 | 0 | 0 |
| U2 | 1 | 0 | 0 |
| U3 | 22 | 3 | 0 |
| U4 | 0 | 0 | 0 |

On passing tasks the longest ownerless stretch was 19 s and the longest queue wait 136 s (p99 40 s),
and no failure repeated more than twice; the bounds leave about 9×, 2× and one more repeat of
headroom. U1 flags a C1 task that sat 181 s in `todo` with a resolved interruption (it also failed
R5), and six R1 tasks in three waves whose run stayed `queued` for 8 minutes while the issue still
showed a retry row: the #20361 shape, which those waves graded only as a late R1. A retry row counts
as a live timer only until its run is dispatched. U2 flags a claude task that failed four times in a
row with `adapter_failed`. Every U3
flag is `adapter_failed`, including three tasks that passed after a retry, which is why U3 stays a
warning until `adapter_failed` names its cause. The audit saw only failure codes; the error-text
part of U3 is checked only in waves run with this harness.

## Time faults (TM1–TM3, `--time-age-hours`)

```sh
# Freeze, sleep and aged outage across running tasks.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads A1,C1 --faults TM1,TM2,TM3 --concurrency 2 --tasks 3 --seed 301
# The aged wait: an approval left pending for a day across a restart.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads G1 --faults TM3 --triggers approval --concurrency 2 --tasks 2 --seed 302
```

The fourth fault family. Every other wave is minutes long on a fresh instance, so nothing time-bound
expires. A time fault makes deadlines lapse during a run or across a restart. No product code changes.

| Fault | What the harness does | Deadlines it crosses |
| --- | --- | --- |
| TM1 freeze | `SIGSTOP` the server process alone for 95–150 s, then `SIGCONT`. The runner, its provider and Postgres keep running. | Controller-instance lease (90 s), execution-control deadline (60 s), legacy run lease (60 s). The runner keeps calling a server that does not answer. |
| TM2 sleep | `SIGSTOP` the server and every process under it for 20–45 s. While they are stopped, shift every database timestamp back by the age. Then `SIGCONT` the same processes. | Everything stored in the database: native and remote execution leases, scheduled retries, liveness and silence watchdogs, accounting closure, and pending waits. The processes' own monotonic timers barely moved. This stands in for a laptop that slept. |
| TM3 aged outage | `SIGKILL` the server tree (as K1). While it is down, shift every database timestamp back by the age. Then start a replacement. | The same deadlines, reconciled by a fresh boot that finds runs, leases, wakes and waits that look hours old. |

The age is 26 hours by default; `--time-age-hours` sets 1–72. The pause and the age are the cheapest
faithful stand-ins:
- A real outage of a day would hold the slot for a day.
- The relevant deadlines are fixed constants, not environment settings.

**Aging.** One transaction moves every time in the `public` schema back by the same interval, so the
database is what it would be had everything happened the age earlier. Future deadlines move into the
past. The shift covers:
- every `timestamp` column;
- every time inside a `jsonb` column: ISO datetime strings keep their format, and whole numbers in the
  wave's epoch-millisecond window move too.

The JSON pass matters. Receipts and snapshots keep copies of times (a continuation receipt stores the
comment's `updatedAt` and compares it later). Shifting only the columns would fail those comparisons, a
harness artifact rather than a product failure. Triggers are turned off for the shift (replica role) so
they do not rewrite derived columns. For the time-bound tables (runs, native finalizations, controller
instances, wakes, environment and workspace leases, workspace operations, approvals, decisions,
interactions, resume claims, routine triggers and recovery actions), the identity, state and
timestamp columns of each row are written before the shift to `<wave>/time-faults/<faultId>.json`.
The per-table counts are in the fault receipt (`timeFault.aging` in `faults.json`) and in the
timeline (`time_fault_aged`).

If a frozen server's open transaction holds a lock the shift needs, the shift times out after 3 s.
The tree then runs for 2 s, is frozen again, and the shift retries; `lockRetries` counts these. An
age must exceed the wave's elapsed time, so shifted and unshifted values never overlap. A fault that
would break this fails as a harness error.

**Grading.** The product sees only the aged values. The observer and grader read through
`TimeShiftedApi`, which adds the age back to the ISO times and epoch milliseconds that a shift moved.
R4 overlaps, R5 evidence, U1–U4 and the speed budgets are therefore judged in real time. Evidence
bundles show the corrected times too.

The age is longer than the wave has run, so a moved value lands before the wave started, and nothing
the wave wrote is earlier than that. One exception stays aged: a deadline that was more than (age
minus elapsed wave time) in the future when the shift ran.

Each later shift also widens the epoch window by the earlier ages, so a value shifted once is shifted
again.

A freeze is a fault window like an outage, from `SIGSTOP` to ready. If a server exits by itself after
`SIGCONT` (for example a lost-lease self-fence), the harness records `serverExitedAfterThaw`, cleans
up the exited server's tree, starts a replacement and grades the tasks. If the cleanup cannot prove
the old tree stopped, the harness records `cleanupError`, starts no replacement, and the fault fails as a harness error.

**Pass rule.** Each task is graded on R1–R6 and its T-oracle as usual:
- the task reaches its correct terminal state, or a diagnosable rest;
- no run executed twice (R4);
- nothing is stuck (R5, R6);
- no Retry for something the system should recover by itself (R3).

For the aged wait (G1 with `--triggers approval`), the approval must still be pending and accepted
when the board decides after a day, and the approved subtask must exist exactly once.

**Limits.**
- Local only. On Daytona the remote runner is not under the server, so it cannot be frozen.
- Agent JWT expiry is not covered. Native runs mint a token per tool call, so a short
  `PAPERCLIP_AGENT_JWT_TTL_SECONDS` tests nothing there.
- The fixed 1-hour runtime-tools token is not covered either.
- Times kept outside Postgres are not aged: in-memory timers and the runner's own state files.
  Neither are times inside `text` columns or HMACs computed over a time.

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

## Pieces

| File | Role |
| --- | --- |
| `supervisor.ts` | Owns the server. Reuses `tests/runner-e2e` process code (config, ports, env isolation, wrapper-owned Postgres, process-tree stopper, `replaceController`). Faults: K1 SIGKILL + immediate restart, K2 SIGTERM + restart, K4 SIGKILL + 2–5 min hold, K6 crash loop. The controller runtime cache is kept (discarding it is K11). |
| `seed.ts` | Chaos Lab company, encrypted provider secrets, native Codex / ACPX Claude / OpenCode agents from the runner-e2e catalog, and the `chaos-sandbox` project (git repo: python CLI, one failing test, `bench.sh` ≈ 4 min) with isolated git-worktree workspaces. It first turns on the instance `enableIsolatedWorkspaces` setting; without it the server ignores the project policy and every repo task shares the primary checkout. |
| `scheduler.ts` | Seeded plan: workload × adapter × fault cells and a random fire time per task. Saved to `results/<wave>/plan.json`. `--replay` reruns one task alone with the same choices and fires the recorded sequence of faults that crossed it (other tasks' faults included) at the same offsets from launch. |
| `observer.ts` | Polls each issue and its runs. When a task rests needing Retry it calls `POST /api/issues/:id/retry` once (once more only if a later fault started after that click), with the body `useTaskRetry.ts` sends. Collects T-oracle artifacts and the R6 sweep. |
| `config-faults.ts`, `config-wave.ts` | Config faults: the reference catalog, seeded plan and oracle (pure), and the wave runner that breaks, restarts, repairs and grades. |
| `grader.ts` | Pure R1–R6 grading over the samples, plus the universal checks. |
| `universal.ts`, `universal-audit.ts` | U1–U4 on every task, and their audit over saved waves. |
| `contention.ts` | L1 workload, its accounting oracle and the `--db-pressure` writers. |
| `workloads.ts` | A1 brief document, B1 python CLI with tests, B5 long bench, C1 comment while running, M1 delegation, G1 approval across a restart, H1 budget hard stop across a restart, with their T-oracles. |
| `journeys.ts`, `journey-driver.ts`, `journey-oauth-app.ts`, `journey-matrix.ts` | Q2 and Q3 definitions and oracles, the board's side of each, Q3's loopback OAuth/MCP app, and the `--matrix` planner. |
| `evidence.ts`, `ledger.ts` | Evidence bundle for each failure and the JSONL ledger plus `SUMMARY.md`. |
| `daytona-image.ts` | Docker-free extraction of the image's runnerd and provider pack, cached per digest, and the controller/image content-ID check. |
| `provider-faults.ts`, `provider-shim/` | PV1–PV3: the resolve hook, the Codex stdio shim, per-task rules and the `provider_fault_applied` check. |
| `question-handoff.ts` | Q1 saved question: the board's answer step and its oracle. |
| `time-faults.ts`, `time-faults-config.ts` | TM1–TM3: process freezing, database aging with recorded rows, and the time-corrected API the grader reads through. |
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
  A task that never rested within its deadline fails R1 as `no_rest_within_budget`,
  whatever its last status.
- Speed: an aggregate p50/p95 row can breach only with at least 5 samples; a
  smaller row is reported as `insufficient sample (n < 5)`. Every cold or warm run
  over its p95 budget, and every restart recovery whose Paperclip share exceeds
  its p95 budget, still fails the wave on its own.
- Faults are serialized; each one hits every task running at that moment.
- A `todo` or `in_progress` task with no live run and no named wait is not a rest. The observer keeps watching it until it resumes or passes the R5 stall limit.
- R5 also fails a run that stays `running` with no live evidence (no new run event, `lastUsefulActionAt` or `execution.lastConfirmedActivityAt`, and no start) for more than 3 minutes after the server is ready. A `running` status alone is not proof of life. A quiet run is still live while a tool it started has not ended (for example a 4-minute `bench.sh`) or while its recorded local runner process still runs with the same PID and start time.
- The wave fingerprints the checkout and `packages/paperclip-runner/dist` at start and after every fault. A build, install or branch switch during a wave would make later restarts run different code, so it fails the wave as a harness error (`worktree_changed_mid_wave`). The baseline is taken after the harness's own setup (preflight rebuilds provider entrypoints) and covers the tracked diff, untracked file contents, the runner `dist` and the runnerd binary. Build before the wave, never during it.
- `faults.json` and `task-faults.json` (each task's launch time and the faults that crossed it) are written after every fault, so `--replay` of a task in an interrupted or wedged wave, or a storm task, re-fires the faults that crossed it at the same offsets.
- A fault that fails to complete fails the wave as a harness error (exit 2), even when recovery brings the server back.

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

Disarmed, a point costs one comparison (about 4 ns), and the arming variables
(`PAPERCLIP_CRASH_POINT`, `PAPERCLIP_CRASH_POINT_CONTROL`) are ignored under
`NODE_ENV=production`, so points may sit on the path before `turn.start`.
In-process tests use `armCrashPointForTest("<name>:<nth>")`, which throws
`CrashPointReached` at the hit instead of killing the test runner.
