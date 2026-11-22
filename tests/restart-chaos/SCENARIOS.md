# Restart chaos scenarios

One section per workload or fault scenario: the command, what the fault does,
and what the oracle checks. Running the harness, Daytona and hosted modes,
grading, and output are in [README.md](README.md).

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

## Redeploy (K15, `redeploy.ts`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-cpu 3 \
  --adapters opencode,claude --workloads A1,C1 --faults K15 --daytona-reuse-lease --concurrency 3 --tasks 6 --seed 9301
```

The hosted staging stack deploys about every 40 minutes. Each deploy replaces
the server's container. The replacement has the same database and volume, but it
runs in another process space (host name, kernel boot and PID namespace) and
has a new Railway deployment id. The server's PID-based proof that an earlier
owner exited (`controller-process-identity.ts`, `owner-proof.ts`) never applies
across a deploy. Recovery must use the deployment proof or the lease deadlines
instead. K1 and K2 restart on the same machine, so every PID proof succeeds and
that path stays untested. See `doc/plans/2026-11-11-staging-failures-vs-chaos-coverage.md`.

K15 emulates the container replacement without a container:

- Every server in a wave that has a K15 is launched with a `--import` preload
  (`redeploy-preload.mjs`). The preload makes `os.hostname()` return a
  per-generation name, which changes the process-space hash.
- Every server gets Railway-shaped variables: `RAILWAY_PROJECT_ID`,
  `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID` and `RAILWAY_DEPLOYMENT_ID`,
  plus `RAILWAY_VOLUME_ID` and `RAILWAY_VOLUME_MOUNT_PATH`, which is the
  instance home.
- A K15 stops the server with SIGTERM, like K2. The replacement starts as the
  next generation, with a new host name and deployment id, on the same project,
  service and volume.
- Other faults in the same wave restart within the current generation, like a
  platform restart of the same deployment.
- Identities derive from the wave id; a replay uses the source wave id, so it sees the same ones.
- Each K15 receipt records `redeploy` (both generations) in `faults.json`, and
  `redeploy_switched` in the timeline.

Limits:

- The Daytona sandboxes and remote runners survive, as they do on staging.
- Local runners are stopped with the server's process tree.
- The cloud stop-proof service (`PAPERCLIP_CLOUD_*`) is not emulated, so stop
  proofs that need it stay unsupported, as on any self-hosted Railway deploy.
- K15 does not combine with MS1–MS3, because a second server would run in the
  real host's process space.
- Combine K15 with `--adapters opencode` and `--daytona-reuse-lease` or
  `--daytona-warm` to match staging's workload mix.

### Long mid-tool redeploy (`--k15-hold-seconds`, T1, Runner logs)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-cpu 3 \
  --adapters opencode --workloads T1 --faults K15 --k15-hold-seconds 240-480 --concurrency 2 --tasks 4 --seed 9310
```

A staging deploy usually lands mid-turn and keeps the server down for 4–7
minutes. In staging class R, recovery then found the remote Runner gone
(`runner_remote_process_identity_unavailable`).

- **`--k15-hold-seconds <n>` or `<min>-<max>`** (0–600 s) seeds each K15's
  outage. The server stops with SIGTERM and stays down for the hold. Then the
  next deploy generation starts. Without the option, a K15 restarts at once.
  The range is drawn only for K15 cells, so other seeds keep their plans.
- **H2** (opt-in workload, staging class H) has the agent save `brief`, then hand
  the task to the person who created it with status `in_review` as its last
  step. The task must rest `in_review` with that person, no run of the task may
  end `issue_reassigned`, and the task must have no execution blocker or active
  recovery action. Run it with a native adapter, for example
  `--adapters claude --workloads H2`.
- **T1** (opt-in workload) has the agent run one shell command in the
  foreground for about 100 s (50 ticks of 2 s). The command prints the loop's
  own clock window. The agent then saves `brief`, whose first line is
  `TICKS-<nonce>=50 start=<epoch s> end=<epoch s>`. Its fault window (35–80 s
  after launch) aims to land while the tool runs in the sandbox, and stays short
  of provider shell-tool timeouts.

  The `fault_crossed_tool` check (skipped for `K0` baselines and provider faults;
  a storm task counts the storm's faults) fails the task unless one of its own faults
  started inside the reported window, with 5 s of clock slack. A fault that hit
  preparation, with the loop run afterwards, tested nothing mid-tool, as a
  provider-fault task whose fault never applied.
- **Runner evidence:** on a Daytona K15 wave, the harness captures every
  started sandbox of the wave three times:
  - right after the server stopped (`<fault>-stopped`);
  - after the hold, just before the next deploy starts (`<fault>-before_start`);
  - at wave end (`wave-end`).
  
  Each capture is written to `results/<wave>/daytona-runner/<label>/<sandbox>.txt`,
  with an `index.json`, and to `runner_logs_captured` in the timeline.
  `daytona-runner-logs.ts` runs one fixed, read-only probe through the Daytona
  toolbox. It reads:
  - every process (`ps`), so a running tool shows as a child of the Runner;
  - memory, disk, and OOM lines from `dmesg`;
  - the tail of every `runnerd.stderr.log`, `runner-process.identity` and
    `runner-state.json`.

  The probe never stops, starts or deletes a sandbox. It only touches sandboxes
  that carry the wave's company and environment labels. Known secret values are
  redacted. A failed capture is recorded and does not fail the wave.

  The whole capture (client, listing and every probe) has one 45 s deadline.
  The capture runs while the server is down, so a slow Daytona API adds at most
  that much to the outage. A capture that hits the deadline is recorded as
  `deadlineExceeded`, and the restart continues. A probe that answers after the
  deadline writes nothing, because its evidence is from after the outage window.

### Redeploy without a volume, with overlap (`--k15-fresh-home`, `--k15-overlap-seconds`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-cpu 3 --storage s3 \
  --adapters codex,opencode --workloads A1,C1 --faults K15 --k15-fresh-home --k15-overlap-seconds 30-150 --concurrency 3 --tasks 6 --seed 9320
```

Staging's deploys after 07:25Z on 2026-11-11 reported `volumeId: null`, and the old container kept running
for a while after the new one was up. Plain K15 restarts on the same instance home and has no overlap.

- **`--k15-fresh-home`** (Daytona only): every deploy generation gets a new, empty instance home
  (`home-g<N>` in the wave's temporary root) and no `RAILWAY_VOLUME_*` variables. Only what a hosted
  deploy gets from outside its container is carried over: the configuration (database, storage) and the
  secrets master key. Controller-local files such as `runtime-context-assets` bundles and runtime caches
  are gone, as in staging class A-deploy (`ENOENT … runtime-context-assets/bundles/…`). Use
  `--storage s3`, as staging does. A local run keeps its workspace and runner under the instance home, so
  the option refuses `--env local`.
- **`--k15-overlap-seconds <n>` or `<min>-<max>`** (5–600 s; staging's shape is 30–150): the wave's port
  becomes an edge proxy (`edge-proxy.ts`), and each server listens on its own port behind it. A K15 boots
  the next generation beside the old server, sends new connections to it once its `/api/ready` reports
  `ready`, keeps the old server running for the seeded overlap, then stops the old one with SIGTERM. There
  is no outage, so the seeded K15 hold is the overlap; it does not combine with `--k15-hold-seconds`.
  The timeline records `k15_fresh_home`, `k15_traffic_switched` and `fault_server_down` (the old server's
  stop).

Pass is the usual grade: no Retry (R3), no stuck record (R6), and the oracle. Staging's terminal errors here
were `ENOENT` on a runtime asset, `Agent directory operation is already active` after a 9.5-minute
`controller_lease_held` wait.
### Staging class R cells (CR1–CR6, `class-r.ts`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-cpu 3 \
  --adapters opencode,claude --workloads T1 --faults CR1 --concurrency 1 --tasks 2 --seed 9501
```

Staging failed with `runner_remote_process_identity_unavailable` in 9 runs. In 8 of them:

1. A deploy kept the controller away for 5–7 minutes.
2. The Runner in the Daytona sandbox survived, and the new controller adopted it.
3. About 40 s later, `session.snapshot` failed because the provider process was dead or unresponsive.

The ninth run had no deploy. A plugin `environmentExecute` RPC stalled for more than 40 s. These cells
reproduce each part. The class is named R on staging. The cells are named CR1–CR3 because the R1 workload
and the R1–R6 grading rules already exist.

| Fault | What it does | Option |
| --- | --- | --- |
| CR1 | The K15 redeploy: SIGTERM, then a held outage, then the next deploy generation. | `--cr1-hold-seconds <n>` or `<min>-<max>`, 0–600. Default 360. |
| CR2 | SIGKILL of the provider process only, inside the task's sandbox. The Runner stays alive. | `--cr2-hold-seconds <n>`, 0–600. Default 0: the controller stays up. With a hold, a K15 redeploy holds the controller down, and the kill happens right after the stop. |
| CR3 | SIGSTOP of the server's Daytona plugin worker and its children. Every plugin RPC, including `environmentExecute`, stalls. There is no deploy. | `--cr3-stall-seconds <n>`, 41–600. Default 45. |
| CR4 | A K1 restart (SIGKILL, no hold). When the replacement is healthy and its server log shows the plugin activated (`plugin-loader: loadAll complete`), its Daytona plugin worker is stopped for the CR3 stall. A stall during activation is a different fault: the plugin's `initialize` call times out and the plugin stays in error. The run's reattachment reads stall while the run recovers: the saved state, the identity marker and the process check. | `--cr3-stall-seconds <n>`. |
| CR5 | The CR3 stall, fired 3–8 s after the task is assigned. It always uses the time trigger and ignores `--fault-after-seconds`. It covers the run's launch: the runnerd launch call and the identity read. It does not need to cross the T1 tool loop. | `--cr3-stall-seconds <n>`. |
| CR6 | A K1 restart (SIGKILL, no hold). The replacement's Daytona plugin worker is stopped for the CR3 stall as soon as it forks, while the server activates the plugin at boot. The worker's `initialize` call times out (15 s). | `--cr3-stall-seconds <n>`. |

- CR2 kills only the processes under the run's `paperclip-runnerd` whose arguments match the adapter's
  provider command. For Claude (ACPX) that is `--output-format stream-json`. For OpenCode it is
  `serve --hostname 127.0.0.1 --port`. The Runner is found by the run id in its listen path.
- CR2 is the only class R action that changes anything in a sandbox. It runs one fixed script, only in
  sandboxes that carry the wave's company and environment labels.
- The run id comes from the task's last sample before the fault. Each kill's output is saved to
  `daytona-runner/provider-kill-<task>-<ms>.json`.
- Each CR task must pass `class_r_fault_applied`. The fault must not have failed, CR2 must have killed a
  provider process, and the CR3–CR6 stall must have ended. A cell whose fault never applied tested
  nothing.
- Use T1, so that the fault lands while a tool runs, as it did on staging. CR5 is the exception: it lands at
  launch, so T1's `fault_crossed_tool` check does not apply to it. Use `--concurrency 1` for CR3–CR6,
  because the stall hits every task's plugin RPCs.

**Sandbox capture.** Every Daytona wave, not only a CR wave, runs the class R probe (`CLASS_R_PROBE`) in
every started wave sandbox. Staging's Runner loss also reproduces with no fault at all (W2 re-wake). Its
output goes to `results/<wave>/daytona-runner/<label>/<sandbox>.txt`. The probe reads:

- every process with its start time (`lstart`), elapsed time and kernel wait (`wchan`);
- TCP sockets with their owners;
- the runtime directory listing, with the size and last write of each file;
- the tail of every log, state or transcript file the Runner or provider keeps. This includes
  `runner-state.json`, the ACPX state files, OpenCode `opencode/log`, and Claude `debug` and `projects`
  transcripts.

The probe runs at these times:

| Label | When |
| --- | --- |
| `<fault>-before` | Just before the fault, with a 20 s deadline. The fault's `startedAt` is taken after it. |
| `<fault>-stopped`, `<fault>-before_start` | CR1 and CR2 with a hold: right after the stop, and just before the next deploy starts. |
| `<fault>-ready+<n>s` | Every 15 s for 180 s after the controller is ready again. It stops after 60 s if the task has rested. Staging failed about 40 s after adoption, so this window covers it. |
| `<task>-rest` | When any task rests, pass or fail, before the product releases the sandbox. |
| `watch+<n>s` | With `--sandbox-watch-seconds <n>` (10–600), on that clock for the whole wave. This catches a Runner exit that no fault announces. |
| `wave-end` | Before the sweep. |

Before PR #20907, a remote Runner wrote its stdout and stderr to `/dev/null`. Only a panic or a graceful
error exit reached `diagnostics/runnerd.stderr.log`. Since #20907, its stderr goes to the bounded
`diagnostics/runnerd.process-stderr.log`, and the probe reads both files. The probe never stops, starts or
deletes a sandbox. An archived or stopped sandbox is recorded by its state alone.

**Results on master `6154b9485e` with #20907** (image `paperclip-daytona-runner@sha256:39df7406…`):

| Wave | Cell | Result |
| --- | --- | --- |
| `w-20261111T192658-s5201` | W2 re-wake, `--faults K0 --daytona-warm`, Codex, 10 tasks | `runner_remote_process_identity_unavailable` twice, with no fault. The follow-up run launched a new runnerd on the warm session state. That runnerd stopped itself: `paperclip-runnerd: controller sequence must be contiguous: expected 13, received 11`. The new controller's journal ended before the predecessor's `runner.drain` and `runner.suspend` (seq 11 and 12). |
| `w-20261111T202055-s9502` | CR1 75 s and CR2, OpenCode and Claude | No refusal. The Runner survived every outage. A killed provider failed the turn with a clear code: Claude `ACP agent reported a terminal connection failure`, OpenCode `opencode_server_exited`. |
| `w-20261111T204144-s9503` | CR1 360 s twice, OpenCode and Claude | No refusal. The Runner and the provider survived both outages. |
| `w-20261111T210055-s9504` | CR3 45 s, OpenCode and Claude | Not the staging code, a separate failure. `runnerd process supervision failed: RPC call "environmentExecute" timed out after 40000ms` failed the run as `notification_transport_failed`. The close path suspended a healthy Runner (`lifecycle: suspended`, no stderr). Retry worked. |
| `w-20261111T223714-s9512` | CR1 360 s, Codex W2, `--daytona-warm --ephemeral-server` (with #20909) | `R1:no_rest_within_budget`, U1 `no_owner_no_action` with the follow-up run queued 485 s. The next controller finalized the run that crossed the outage. Its continuation queued while that run's warm lease was still `active`, so the claim was declined. No dispatch pass ran after the lease was retained, and the run stayed `queued` for 19 minutes with no Retry. Lease release and native finalization writes now send a queued-run dispatch signal, and a declined claim logs its reason (`claimQueuedRun: queued run declined at the issue execution claim`). As a backstop, the run-dispatch worker re-drives an undispatched queued run 60 s after it was created, then with a doubling interval up to 15 minutes, and the ownership reconciler reports one still queued after 5 minutes as I7 `queued_run_not_dispatched` and re-drives it once. |

### Volume-free servers (`--ephemeral-server`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --storage s3 --ephemeral-server \
  --adapters codex --workloads W2 --faults K1,K2,K15 --k15-fresh-home --k15-overlap-seconds 30-90 --concurrency 3 --tasks 3 --seed 5501
```

Cloud servers run volume-free (`ephemeral-server-contract.ts`): agent files, run logs and UI assets live in object
storage, secrets use one stable master key, and remote agent directories are disposable copies whose collection and
cleanup take the per-agent Postgres operation lock. Every other wave runs the volume-backed mode, so those paths,
including the `directory-lock` recovery step, are never reached there. `--ephemeral-server` gives every server of the
wave `PAPERCLIP_EPHEMERAL_SERVER`, `PAPERCLIP_DURABLE_AGENT_FILES` and `PAPERCLIP_SHARED_UI_ASSETS`, the wave's
Postgres as `PAPERCLIP_DATABASE_LISTEN_URL`, a stable `PAPERCLIP_SECRETS_MASTER_KEY` (also written to the config's
key file inside the wave's temporary root; `assertIsolatedServerEnvironment` admits that one generated key and still
refuses an inherited key or `PAPERCLIP_SECRETS_MASTER_KEY_FILE`) and `RUN_LOG_S3_*` in the wave's object store. It needs
`--storage s3` and `--env daytona` (a local workspace blocks a volume-free server) and does not combine with K14. Workloads with the fixture repository (B1, B5,
F1, R1) are a `local_path` project source, which a volume-free server refuses: they are dropped from the default
workloads and refused when listed.
`--k15-fresh-home` implies it (and defaults `--storage` to `s3`): a new instance home without the volume-free mode
loses the agents' instruction bundles, which staging keeps in Postgres and object storage. Every restart replays the server's startup
eligibility check, so a replacement that refuses to start fails the wave.

### Runner exits before session.open (`--runner-bind-fault`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-warm --storage s3 \
  --ephemeral-server --adapters claude --workloads W2 --faults K1,K2,K15 --k15-fresh-home --runner-bind-fault --seed 6402
```

Staging's volume-free shape (wave `w-20261111T230537-s6402`) showed a reused warm sandbox whose Runner listen port
was still held by another Runner. The new Runner wrote `runner-state.json` (`lifecycle: connecting`), failed with
`runner_ingress_bind_conflict` and exited before `session.open`, so it never wrote its provider state. The same-run
bootstrap retry then found that partial session root and failed with `runner_harness_state_mismatch: resumed_unavailable`.
`--runner-bind-fault` gives every server of the wave `PAPERCLIP_TEST_RUNNER_BIND_FAULT=first_launch` (honoured only
with `NODE_ENV=test`): before a run's first Runner launch on that server, a short-lived process in the sandbox holds
the Runner's listen port for 15 s. The server waits until that listener has bound the port and writes
`[paperclip-runner] test bind fault armed on port <n>` (or `failed`) to the run log, so a wave can count the runs that
really took this path. Every run then takes it once per server generation, and the run must still finish without
Retry. It needs `--env daytona`.

## Release swap (RS1, `--release-swap`)

```sh
# Smoke: 2 swaps, 5 minutes apart, 90 s overlap, 2-minute settle.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local --adapters opencode --workloads A1,T1 \
  --release-swap --release-swap-count 2 --release-swap-spacing-minutes 5 --release-swap-overlap-seconds 90 \
  --release-swap-settle-minutes 2 --concurrency 2 --tasks 40 --seed 7101
# The default wave: 6 swaps, 40 minutes apart, 8.5-minute overlap, 15-minute settle, staging's volume-free shape.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --storage s3 \
  --daytona-warm --daytona-cpu 2 --adapters opencode,codex,claude --release-swap --concurrency 12 --tasks 200 --seed 7100
# The short form for hourly comparisons of fix PRs: 3 swaps, 12 minutes apart, the same 8.5-minute overlap, 15-minute settle.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --storage s3 \
  --daytona-warm --daytona-cpu 2 --adapters opencode,codex,claude --release-swap-short --concurrency 12 --tasks 200 --seed 7110
```

With `--workload staging-mix`, the swaps become the mix's fault slots (`--mix-fault-spacing-minutes` and `--mix-minutes`
come from the swap count and spacing), so the staging-mix tasks, follow-ups and hands-off results run under the swap
driver's probes and grading. Probe agents finish their verification while the first tasks run; the first swap waits for them.
`--server-from <dir>` also runs on Daytona: every server comes from that checkout while the sandboxes keep
`--daytona-image`'s Runner and provider pack, as a deploy newer or older than its sandbox image does.

### Staging twin cells

Two local servers, volume-free, real Daytona sandboxes, two overlap swaps. `$IMG` must match the checkout's Runner
(`--server-from`'s checkout when given). Run each through the wave queue (`~/.cache/paperclip/chaos-wave-acquire.sh`).

```sh
set -a; source ~/.secrets; set +a
# Twin cell, variant G (graceful swaps): 6 tasks, 6 runs, 4-minute turns, 2 swaps 4 minutes apart, 120 s overlap. 18-23 minutes.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-warm --daytona-cpu 1 --storage s3 \
  --workload staging-mix --mix-tasks 6 --mix-runs 6 --mix-queue 0 --mix-ratio opencode=34,codex=33,claude=33 --mix-turn-minutes 4 \
  --mix-hold-minutes 2 --mix-arrival-cutoff-minutes 0 --release-swap --release-swap-count 2 --release-swap-spacing-minutes 4 \
  --release-swap-overlap-seconds 120 --release-swap-settle-minutes 1 --seed 7105
# Variant G2: the same command; the outgoing server is SIGKILLed 120 s into each overlap.
RESTART_CHAOS_K15_KILL_OLD_AFTER_SECONDS=120 node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts ...
# Variant G3: G2, and the incoming server is also frozen (SIGSTOP) for 150 s while the outgoing one stops, so it reaches the Runners late.
RESTART_CHAOS_K15_KILL_OLD_AFTER_SECONDS=120 RESTART_CHAOS_K15_FREEZE_NEW_SECONDS=150 node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts ...
# Loaded twin L1: 48 tasks, 20 runs plus 20 queued, 12-22 minute turns, 2 swaps 13 minutes apart, swap 1 graceful, swap 2 G3. About 78 minutes.
RESTART_CHAOS_DAYTONA_VCPU_BUDGET=48 RESTART_CHAOS_K15_KILL_OLD_SWAPS=2 RESTART_CHAOS_K15_KILL_OLD_AFTER_SECONDS=120 \
RESTART_CHAOS_K15_FREEZE_SWAPS=2 RESTART_CHAOS_K15_FREEZE_NEW_SECONDS=150 RESTART_CHAOS_MIX_BANNER_REST_SECONDS=240 \
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-warm --daytona-cpu 1 --storage s3 \
  --workload staging-mix --mix-tasks 48 --mix-runs 20 --mix-queue 20 --mix-ratio opencode=34,codex=33,claude=33 --mix-turn-minutes 12-22 \
  --mix-hold-minutes 2 --mix-arrival-cutoff-minutes 0 --release-swap --release-swap-count 2 --release-swap-spacing-minutes 13 \
  --release-swap-overlap-seconds 120 --release-swap-settle-minutes 1 --seed 7301
```

| Knob | Effect |
| --- | --- |
| `RESTART_CHAOS_K15_KILL_OLD_AFTER_SECONDS` | SIGKILL the outgoing server this many seconds into the overlap (at most the overlap) instead of a SIGTERM at its end |
| `RESTART_CHAOS_K15_KILL_OLD_SWAPS` | comma-separated swap numbers (1-based) the kill applies to; unset means every swap |
| `RESTART_CHAOS_K15_FREEZE_NEW_SECONDS` | SIGSTOP the incoming server for this long while the outgoing one stops, then SIGCONT |
| `RESTART_CHAOS_K15_FREEZE_SWAPS` | swap numbers the freeze applies to; unset means every swap |
| `RESTART_CHAOS_MIX_BANNER_REST_SECONDS` | a hands-off staging-mix task whose Retry banner has stood this long rests (it is still reported as a banner) instead of waiting out its budget |
| `RESTART_CHAOS_MIX_FIRST_SLOT_SECONDS` | place the first staging-mix fault slot this early (at most the slot spacing); the slot count stays the same, so a release swap never gets an extra swap |

A run counts as a success only when `staging-mix-summary.md` shows every started task completed hands-off
(`completed hands-off / started` equal), `Retry banner shown: 0`, `Retry worked / Retry clicked` equal, `extra turns: 0`
and `duplicated side effects: 0`, the release-swap headline shows every task completed without human action, and the
Daytona cleanup left no sandbox (`left after deletion: none`). The `follow-up answered in a later run` line is not a
failure; read its waits. In L1 the queued tasks wait for a slot by design; U1 allows that wait (see "Universal checks").

`--release-swap` runs the full default (6 swaps, 40 minutes apart). `--release-swap-short` runs 3 swaps 12 minutes
apart with the full 510 s overlap, so two servers run for most of each cycle. Either takes the `--release-swap-*`
options below, which override the preset. Workload sizing (turn length, concurrency) comes from the workload flags.

Staging takes a release about every 40 minutes as an overlap swap: the incoming server B starts with a new
deployment identity and process space against the same database and storage while the outgoing server A keeps
serving and driving runs; both run for 8–9 minutes; then A gets SIGTERM. RS1 repeats that swap on one database,
so state saved during swap N is resumed after swaps N+1 and N+2.

- **Each swap** is a K15 rolling redeploy (`redeploy.ts`, the edge proxy of `--k15-overlap-seconds`). B boots
  beside A, the edge sends new connections to B once B reports `ready`, both stay up for the overlap, and A
  gets a graceful SIGTERM. B becomes A for the next swap. On `--env daytona` the cell adds `--k15-fresh-home`
  and `--ephemeral-server` (staging's volume-free shape, which needs `--storage s3`); locally both servers
  share the instance home.
- **Schedule** (`release-swap-schedule.ts`): swap *k* starts *k* × spacing after the wave starts, never before
  the previous one settled. Tasks keep launching from the `--tasks` pool, during the overlap too, until the last
  swap settled; then they drain. The next swap never starts before the previous outgoing server has exited, and the
  spacing must leave the overlap plus 2 minutes for the incoming server's boot. The cell plans its own swaps, so it refuses `--faults`, `--storm-minutes`,
  `--k15-overlap-seconds`, `--k15-hold-seconds`, `--replay`, `--crash-point`, `--matrix` and `--upgrade-from`.
- **The outgoing server starts runs** (`release-swap-driver.ts`, `release-swap-setup.ts`). The harness hires one
  probe agent per adapter, a copy of the seeded agent with its own concurrency (10 locally, 4 on Daytona), so
  probes never queue behind the workload. It creates small probe tasks (the A1 brief) for it through A's own port,
  not the edge: one when B is spawned, then one every 3 s locally (20 s on Daytona, at most 6 or 8) and one when B
  enters its startup recovery pass (`/api/ready` reports `recovering`) for as long as B boots, while the run sampler
  reads every 500 ms, and one timed so that its run
  starts about 20 s before A's SIGTERM (the wake goes out 20 s plus the swap's measured wake-to-start latency
  early). Every 2 s from B's spawn
  until 60 s after A stopped, the harness samples the wave's runs and their owning controller's PID. Each swap
  records which runs A and B started during the overlap, whether the late probe's run was started by A within the
  60 s before its SIGTERM, and whether a run A started was still preparing (`execution_stage` `preparing` or
  `dispatching`) while B's recovery pass ran. The owner is the run's controller boot (`heartbeat_runs` for legacy
  runs, `native_run_finalizations` for native runs). The recovery pass is the time B's `/api/ready` reports
  `recovering`; a swap where that phase was never seen has no recovery evidence. A run the product starts
  elsewhere is reported as a finding, not forced. A swap whose outgoing server is never stopped (B failed to
  start, the wave ended, or the harness was interrupted) is marked abandoned, and its sampling stops.
- **Plug-ins.** `ReleaseSwapDriver.plugins` is the per-swap hook list. Each plug-in sees every phase
  (`before_spawn`, `spawned`, `switched`, `stopping`, `stopped`); a plug-in that returns a checkout directory at
  `before_spawn` makes B (and every later server) run that build, for the mixed-version variant.

| Option | Default | Range |
| --- | --- | --- |
| `--release-swap-count` | 6 | 1–24 |
| `--release-swap-spacing-minutes` | 40 | 2–120; must exceed the overlap plus 2 minutes |
| `--release-swap-overlap-seconds` | 510 | 30–600 |
| `--release-swap-settle-minutes` | 15 | 1–60 |
| `--release-swap-drain-minutes` | the longest task budget plus the settle | 1–240 |

**Disk.** On Daytona (`--k15-fresh-home`) each swap removes the outgoing generation's instance home once that
server has stopped (the first home holds the database and stays). Every swap records the temporary root's size
(`release_swap_disk`). The wave's temporary root is removed when the wave ends; what stays is `results/<wave>`.

**Grading** (`release-swap-grade.ts`, `release-swap-finish.ts`) runs once, after the last swap plus the settle
period and a bounded drain: the grader waits until no started task has a queued or running run with activity in the
last 5 minutes and no run was created or finished for a quiet period of 90 s (`QUIET_PERIOD_MS`), or until the drain
cap. The quiet period lets a continuation the product wakes after a run ends (for example a parent woken when its
subtasks finish) start before the read, so the task is graded by that continuation, not as `nothing pending`. A task still running at the cap is not counted in the number; the headline
reports how many with the age of their last activity, and the wave fails. The grade uses the same 5-minute threshold:
after the drain, a run with no event for 5 minutes, a queued wake, a scheduled retry or a working notice with no
progressing run behind it is not pending work, so the task is `nothing pending`. Queued wakes behind a queued or running run wait for that run by design, so the detail does not call them never dispatched. The single read then covers every task of the wave's company that had a run (probes and agent-created subtasks included), the
way the board shows it:

| Verdict | When |
| --- | --- |
| `pass` | Done, and nobody clicked Retry. Failed runs the system recovered from do not count against it. |
| `needed_retry` | Retry was clicked, during the wave by the observer or now by the grader (the board's Retry button when the UI is served, else the same API call). The result says whether the click worked: accepted, then a later run succeeded or the task is done, checked again after another settle period. |
| `open_no_owner` | To do or in progress with no live run, no queued wake and no named reason a person must act. |
| `blocked_non_person` | Blocked, held by an execution blocker or a board recovery action, or interrupted, for a reason that is not a person's. A board request such as `choose_model`, `assign_agent`, `resume` or `confirm_run_stopped` counts here: the board asks a person, but it is not one of the reasons below. |
| `waiting_on_person` | Rests on approval or a question (pending records in the database), a dependency, review, a usage-limit wait, budget or a shared credential. |
| `still_working` | Still has a live run, a queued wake, a scheduled retry or a system recovery action after the settle period. |

Every failing task carries exactly one label, counted per wave on the summary's `Failing:` line: `nothing pending`
(`open_no_owner`, or cancelled with no person asking), `blocked for a non-person reason` (`blocked_non_person`), or
`needed Retry (click worked | click did not work | click result pending)`. A queued or running run with no run event
and no update for the settle period is not a live owner. A task whose view cannot be read in time is left out of the
grade, and the headline says how many: the number is then incomplete and the wave fails.

Only `pass` counts as completed. Each grade names its reason, and the summary counts the non-passing tasks by
verdict and reason, so a wave shows which failure each task rests in. The first line of `release-swap-summary.md` (also the top of `SUMMARY.md`) is
the wave's one number: `<pass> / <started> tasks completed without human action`. The table under it gives per
swap the runs that failed (`failed`, `timed_out`, `interrupted`) at that swap: live at the outgoing server's SIGTERM, or
failed within 15 minutes of it (`RELEASE_FAILURE_WINDOW_MS`). Other failed runs are listed on their own line as failed
outside a release window. The table also gives the runs that
failed with a lost-ownership code while the outgoing server was still alive and owned them, and the time from
A's SIGTERM to the next event of each run that was live across it and did not fail. `release-swap.json` holds
every grade, every failed run with its error code, message and last error events, each swap's run samples and
probes, and the duplicates: two runs of one task executing at once, two Runner processes for one run, repeated
identical agent comments and repeated subtask titles. The product's per-turn notice "Prepared <document> for this
response." is not a duplicated comment; its repeats are counted on the same line as information only. The wave fails
unless every task passed.

**Swap moments.** Each swap has five moments, in the timeline as `swap_incoming_spawned`, `swap_incoming_ready`,
`swap_traffic_switched`, `swap_outgoing_sigterm` and `swap_outgoing_exited`. `fault_started` marks only that the swap
was requested (`marks: "swap_requested"`); it carries no signal for an overlap swap, and the outgoing server's real
SIGTERM is `swap_outgoing_sigterm`. `incoming_ready` is the moment the supervisor confirmed readiness before switching
traffic, or the readiness watcher's earlier answer, so it never falls after `traffic_switched`. The summary prints the five times per swap, then each run started during the swap
with the two moments it started between and whether the outgoing or the incoming server started it
(`release-swap-moments.ts`).

## Absolute symlink in the workspace (F1)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-cpu 3 \
  --adapters codex,opencode --workloads F1 --faults K2 --storage s3 --concurrency 2 --tasks 2 --seed 9304
```

F1 is opt-in. The agent creates `hosts-link-<nonce>`, which is an absolute
symlink to `/etc/hosts`, in its repository workspace and keeps it. It also
writes a notes file, and then marks the task done.

On staging, a remote save-back refused such a link
(`remote_workspace_archive_unsafe_symlink`). The save-back then used up its
retries and left the task blocked. Agents create absolute links in ordinary
work, for example in tool caches or `node_modules/.bin`.

The oracle passes when:

- the task is `done`;
- the notes file is saved, without a Retry.

How the product saves the link itself (skip it, keep it, or record it) is not
graded. F1 is meaningful with a remote workspace (`--env daytona`, with
`--storage s3` as on staging). Locally it is a plain repository task.

## Sandbox disk full (DF1)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-cpu 3 \
  --adapters codex --workloads R1 --workspace-repo "$PWD" --faults DF1 --storage s3 --concurrency 2 --tasks 2 --seed 9412
```

On staging, saving a run's result back from its sandbox failed because the sandbox disk was full
(census class F, `doc/plans/2026-11-11-staging-failures-vs-chaos-coverage.md`). The product then
ends saved-work recovery at once with cause `sandbox_disk_full` and offers a Retry (#20758).

A full disk cannot be made on demand, so DF1 uses a test-only hook in the server
(`server/src/services/sandbox-disk-full-fault.ts`). The harness starts its server with
`PAPERCLIP_DISK_FULL_FAULT_CONTROL=<file>` and `PAPERCLIP_DISK_FULL_FAULT_RECEIPT=<wave>/disk-full-faults.jsonl`.
The hook reads the variable once at startup and ignores it when `NODE_ENV=production`. Without it the
hook is one comparison and the save uses its own target.

- **Armed**: when a DF1 task launches, the harness writes its issue id to the control file. Each
  final workspace save of that task (finalization's copy-back and recovery's re-save) then gets what
  a full sandbox returns: every capture command exits 1 with the product's disk-full message, and
  the provider download fails with `No space left on device`. The product's own code does the rest.
  The server appends one receipt per faulted save.
- **Cleared**: when the task rests with the cause `sandbox_disk_full` (or is `done`), the harness
  records what the board shows, removes the id, and then the observer clicks Retry, as a person who
  freed space would. A board-owned recovery can look like a rest while it still checks the saved
  source; the harness keeps waiting there for up to 10 minutes (`DISK_FULL_REST_SETTLE_MS`) before it
  clears the fault anyway, so that recovery's own save cannot hide the disk-full rest.

The task passes when:

- the fault reached at least one save (a receipt for the task);
- it rested with recovery cause `sandbox_disk_full` and a Retry offered (T check `disk_full_fault`);
- exactly one Retry, after the fault cleared, finished the task (R3). A needed Retry is expected
  here, so R3 passes on it. Whether that Retry starts a new run is not graded.

The ledger line records `diskFull: { faultedSaves, restedDiskFull, retryOffered, retryWorked }`.

DF1 restarts nothing and needs `--env daytona --storage s3`: only a remote workspace has a sandbox
save, so the harness refuses other setups. Use R1 with `--workspace-repo`. With the chaoscli fixture
(B1) on Daytona, the workspace is a local worktree synced into the sandbox, so no remote save runs
and the task fails as `not_applied` (wave `w-20261111T131314-s9411`). An unchanged workspace also
skips the capture.

The observer clicks Retry in the board UI, as for every other cell. In waves `w-20261111T131941-s9412`
and `w-20261111T134316-s9413` the disk-full rest showed "Recover saved files", not a Retry button, while the API reported
`canRetry: true`; R3 records this as `ui_retry_button_missing`.

## Environment-provider faults (EP1, `env-provider-wave.ts`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/env-provider-wave.ts --fault EP1 --adapters codex --tasks 2 --seed 71
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/env-provider-wave.ts --fault EP1N --tasks 1 --seed 72
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/env-provider-wave.ts --fault EP1D --tasks 1 --seed 73
```

Lease acquisition fails before any provider call, in the shapes staging recorded
on 2026-11-11: Daytona's acquisition deadline ("lease acquisition timed out;
allocation cleanup is pending") and a failed database query. The server seam
`server/src/services/environment-lease-fault-injection.ts` (test mode only) reads
`PAPERCLIP_CHAOS_LEASE_FAULT_CONTROL` and fails each task's first N acquisitions.
It runs on a local instance; no sandbox provider is needed. One fault per wave.

| Fault | Shape | Pass |
| --- | --- | --- |
| EP1 | Deadline, 2 times (the automatic bound), then succeeds | Exactly 2 `environment_provider_unavailable` runs, no `setup_failed`, completes with no user action |
| EP1N | Deadline on every attempt | 3 failed runs, the task rests offering Retry; the harness disarms, clicks Retry, and the task completes |
| EP1D | Database error once, then succeeds | 1 failed run, completes with no user action |

Every fault also fails if a board-owned recovery action is ever active on the
task, and the A1 brief oracle must pass. Results go to `results/<wave>-ep/`.

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
| ST4 | partial multipart: for workspace snapshot uploads, a seeded subset of parts 1–4 fails with 500/503, a connection reset, or a reset after 1–4 MiB of the part body; sometimes `CompleteMultipartUpload` also fails (500 or reset). Each fault hits 1–3 times or for the whole window |
| ST5 | credentials rejected: every request answers 403 `ExpiredToken`, `InvalidAccessKeyId` or `SignatureDoesNotMatch` (seeded per window) |
| ST5R | real key rotation: MinIO restarts with a new root key (old key revoked), and the server's credential source keeps serving the old key until the window ends |
| ST7 | read-after-write lag: a `GET` or `HEAD` of an object answers 404 `NoSuchKey` for 5–30 s (seeded) after its `PUT` or multipart completion succeeded |
| ST8 | provider-session backup throttle: the next 9–12 (seeded) `PUT`s of a native harness backup answer 503 `SlowDown`, more than one request's own throttled retries. This is the post-turn close checkpoint of a remote (Daytona) run, so use it with `--env daytona --storage s3` |

With ST4, ST7 or ST8 in the wave, the harness audits the store when the wave ends (`storage-audit.json` and a
`Storage audit` section in `SUMMARY.md`). It reads every committed workspace snapshot back from MinIO and checks
its size and SHA-256 against the snapshot row, and after the server stops it lists incomplete multipart uploads
under the wave's prefix. An orphaned upload, a committed snapshot that does not read back, a planned ST4, ST7 or ST8 fault
that never changed a request, or a skipped snapshot check fails the wave. ST4 truncation forwards the first bytes
of the part to MinIO before it cuts both connections.

With ST5R the server gets no static key: `AWS_PROFILE` names a profile in a wave-owned `AWS_CONFIG_FILE`
whose `credential_process` prints the key currently in `aws-credentials/current.json` under the instance
temp root. Each ST5R window rotates the store's key at its start (requests are held up to 5 s while MinIO
restarts on the same loopback port) and publishes the new key to that file when it ends, so only a server
that re-resolves its credentials after a rejection keeps going. Rotations and publishes are logged as
`storage_credentials_rotated` and `storage_credentials_published`. All keys are random and disposable.

`--storage-fault-seconds 15-45` sets the window length range (5–900 s), for example to find how long
an outage a run survives. The windows are logged in the timeline and written to `storage-faults.json`.
The speed grade removes storage fault window time from spans and restart recoveries the same way it
removes restart outage time (overlap counted once), and reports the removed time on its own line in
`SUMMARY.md` and as `storageFaultRemovedMs` in `speed.json`.

With `--env daytona --storage s3`, each task's workspace is a remote workspace: the controller saves
and restores it through the store, so the faults also hit workspace save, restore and copyback. R1
(`--workspace-repo`) runs on Daytona only with `--storage s3`: the project points at the checkout's
GitHub `origin` over https at its `origin/master` commit, so the sandbox clones the repository and its
snapshots are Paperclip-sized. Its oracle reads the task's files through the board API, retrying for up
to 4 minutes while the closing save makes the workspace readable, and runs its commands on a local copy.

### Restart during a transfer (`--storage-trigger`)

A time-based fault rarely lands while the server is moving bytes. `--storage-trigger <target>` turns
each task's planned K fault into an armed fault: at its planned time (`--fault-after-seconds` pins it)
the fault is armed, and it fires the moment the proxy sees the next matching server request. The
proxy holds that request (up to 60 s) while the harness takes its pre-fault snapshot and restarts the
server, so the restart provably interrupts the transfer.

| Target | Matching request |
| --- | --- |
| `snapshot-upload` | `PUT` with a body under `workspace-snapshots/` (single PUT or multipart part; not create or complete) |
| `snapshot-part` | multipart `UploadPart` (`PUT …?partNumber=`) under `workspace-snapshots/` |
| `snapshot-download` | `GET` under `workspace-snapshots/` (restore) |
| `run-log` | `PUT`/`POST` under `run-logs/` (run-log journal segments) |

`storage-trigger.json` records, per armed fault, the request that fired it (method, path with upload
ids hidden, declared bytes, outcome `aborted`/`completed`), every request in flight at that
moment (the held one included), and the fault id it produced. A fault whose task rested first, or that saw no matching request
before the wave ended, is recorded with `missedReason` (`task_rested` or `no_matching_request`). The wave
summary adds a "Storage trigger" section with each armed fault's result and the count not reached. It
fails when no restart fired, or when a fired restart has no fault id or its held request was not
`aborted` (the hold expired first). It needs `--storage s3` and `--triggers time`, and does not take
G1, H1 or Q1: their board actions would run while the fault waits for a request.

### Restart at native start (`--native-trigger`)

A time-based fault on a remote workspace often lands while the run is still preparing. `--native-trigger <target>[+<seconds>]`
turns each task's planned K fault into an armed fault: at its planned time (`--fault-after-seconds` pins it) the fault is armed,
and it fires `<seconds>` (0-600) after the next matching event of the task's running run.

| Target | Matching run event |
| --- | --- |
| `native-start` | `native.process_start_requested` (the executor is about to start the runner) |
| `provider-event` | the first `session.started`, `turn.submitted`, `turn.started` or `turn.accepted` |

For example, `--native-trigger native-start+5` restarts the server five seconds after native start. `native-trigger.json` records,
per armed fault, the run and event that fired it, the delay after the event, and its fault id. A fault whose task rested first, or
that saw no matching event, is recorded with `missedReason` (`task_rested` or `no_matching_event`). The wave summary adds a "Native
trigger" section and fails when no restart fired. It takes `--triggers time` only, not `--storage-trigger`, and not G1, H1 or Q1.

`--native-trigger-outage <seconds>` (10-900, with `--storage s3` and no `--storage-faults`) also starts an ST1 outage of that
length the moment each trigger fires, just before the restart. The recovered run then prepares while the store is down. The
windows are written to `storage-faults.json` and removed from the speed grade like planned storage faults.

Every Retry the grader needs is clicked in the real board UI: the harness opens the issue in a headless
Chromium, waits for the visible Retry button and clicks it. A task whose Retry button is missing fails
R3 as `ui_retry_button_missing (user saw: …)`; a click that sends no retry request fails as
`ui_retry_no_request`. Before it looks for Retry, the harness closes any open modal that covers the page
("Not now", else Escape) and records it in the attempt's `dismissedDialogs`. A visible Retry that stays
unreachable behind a modal that will not close fails as `ui_retry_blocked_by_modal`. Crash-point waves
serve no UI and click Retry through the API.

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
# The same for Claude (ACPX): its interrupted prompt's response is held 18 s.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters claude --workloads Q1 --faults PV1 --concurrency 1 --tasks 1 --seed 104
# A dropped terminal straddles a control-plane kill -9: K1 fires 3 s after the drop.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads Q1 --faults PV2 --provider-fault-restart K1 --concurrency 1 --tasks 1 --seed 105
```

The third fault family: the provider stays alive, but one protocol message between the runner and the
Codex app-server is late, missing or repeated. `--faults` takes them next to restart faults:

| Fault | The chosen message |
| --- | --- |
| PV1 | is held for the task's delay (`--provider-fault-delays`, seconds, cycled across tasks; default 18) |
| PV2 | is dropped |
| PV3 | is sent twice |

`--provider-fault-message terminal` (default) picks the turn's end after an interruption, which a
governed wait (a saved question or approval) or a board Stop sends. `interrupt_ack` picks the
acknowledgement of that interruption. Each rule applies once per task, to the first matching message
(Q4: the second). Provider faults run only with `--env local --adapters codex,claude` (either or both) and only with
workloads that interrupt a turn (Q1, Q4, S1). G1 does not: its agent asks for approval through `call_api`
and ends its own turn, so no rule ever applied there (waves w-20261110T050407-s206, w-20261110T063253-s208,
w-20261110T085554-s211) and the board waited for a restart that never came. A PV1 task passes `provider_fault_applied` only when the
held message was released; a provider that exited first turned the delay into a drop.
For Claude, the runner settles a cancelled turn about 3–4 s after the cancel without waiting for the
provider's prompt response, and it later closes the sidecar with the provider. A Claude PV1 delay
longer than that is therefore a drop (wave w-20261110T040202-s202: 18 s held, never released, the task
still passed its Q1 oracle). Sweep Claude PV1 below that window, for example
`--provider-fault-delays 1,3`.

On a board Stop (S1) the runner ends Codex without waiting for its terminal:
in wave w-20261110T050407-s206 Codex exited 1.5 s after `turn/interrupt` with no `turn/completed`, so a
`terminal` rule never applies there and the task fails `provider_fault_applied`. Use `interrupt_ack` for S1.
An S1 task with a provider fault clicks Stop on the first poll that shows a live provider turn
(`turn.started` with no turn terminal yet), not after the seeded follow-up window. A fast agent used to
finish before that window, so the fault was never injected (waves w-20261110T082702-s212 and
w-20261110T091057-s213, t03: `applied=0`). The continue comment still waits for the window. If the
run ends before any live turn is seen, the Stop is recorded as missed once the task rests after the window.
A live turn is seen only when a poll (`--poll-ms`, 2–5 s) lands inside it, so a turn shorter than the
poll interval can still be missed. A runner replacement or stop clears the live-turn mark, as it does for
an open tool.

**A tool result that never reaches the agent (`tool_completed`, Codex only).**
`--provider-fault-message tool_completed` drops (PV2), holds (PV1) or repeats (PV3) Codex's
`item/completed` for the turn's first Paperclip tool call other than `paperclip_finish` and
`paperclip_block`. The model has the result, but the runner never records that it reached the model,
as when Codex cancels the nested exec cell that made the call. In two staging Codex runs
(2026-11-11) every later `paperclip_finish` was then refused with
`terminal_call_before_results`, the turn ended with no semantic result, and the same-run recovery
failed the run. No turn is interrupted, so the workloads are those that save a document and then
finish (A1, C1):

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads A1 --faults PV2 --provider-fault-message tool_completed --concurrency 1 --tasks 1 --seed 301
```

The task passes when the fault applied once and the ordinary A1 grade passes (the brief is saved and
the task is `done`).

| Adapter | `terminal` | `interrupt_ack` |
| --- | --- | --- |
| Codex | the `turn/completed` after a `turn/interrupt` | the response to that `turn/interrupt` |
| Claude (ACPX) | the provider's ACP `session/prompt` response after a `session/cancel` | the sidecar's response to the runner's `turn.cancel` (ACP's `session/cancel` is a notification with no acknowledgement) |

**Across a restart.** A PV task fires no restart unless `--provider-fault-restart K1` is given. Then each
PV1 or PV2 task also kills -9 the control plane `--provider-fault-restart-after-seconds` (default 3)
after its fault applied, through the `provider` trigger. That delay must be shorter than every PV1 delay,
so the message is still held, and the wave runs with `--concurrency 1`, because every K1 kills the whole control plane. K1 kills the runner with its provider and the held message, so the late
or missing terminal straddles the restart: the replacement control plane must settle the saved wait
without it. Planned restart faults (`--faults K1,PV2`) are still rejected, and PV3 does not combine with
a restart, since a duplicate holds nothing.

`--provider-fault-restart` also takes K2 (SIGTERM, a graceful restart whose shutdown drain meets the
held or missing message) and K4 (kill -9, then the control plane stays down for 120 s, the low end of
the seeded K4 range). For a restart, `provider_fault_applied` requires that the held message was not
released before the old control plane stopped (`stoppedAt`), not only before the fault started. A K2 drain took 15–20 s in wave w-20261110T092735-s213, so a PV1 that must straddle a K2 needs a
longer delay, for example `--provider-fault-delays 40`. A comma list such as `K1,K2,K4` cycles across the PV1/PV2 tasks in plan order,
so one wave covers several restart kinds. `--provider-fault-message` takes `WORKLOAD=message` entries
next to the default, for example `S1=interrupt_ack,terminal`: S1 tasks fault the interrupt
acknowledgement (Codex ends a Stop without its terminal) while Q1 tasks fault the terminal.

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads Q1,S1 --faults PV1,PV2 --provider-fault-restart K2,K4 --provider-fault-delays 40 \
  --provider-fault-message S1=interrupt_ack,terminal --concurrency 1 --tasks 4 --seed 211
```

Such a task passes when:

- `provider_fault_applied`: the fault applied once, the restart started after it, the held message was
  not released before the old control plane stopped, and it was not discarded before the restart started
  (a discard during a K2 shutdown is the restart stopping the provider);
- the ordinary grade passes: R1–R6 for a restart-crossing task and the workload's T-oracle. For Q1
  that means one question, the asking run `succeeded`, no failed run, nothing started before the
  answer, and the brief carries the answer.

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

**Claude seam** (`acpx-provider-faults.ts`, `provider-shim/acpx-sidecar-hook.mjs`,
`provider-shim/acpx-fault-tap.cjs`). Claude runs through the ACPX sidecar. Its provider package and
runtime are digest-verified and run from private snapshots with a scrubbed environment, so the Codex
approach of replacing the executable cannot work. The sidecar itself is the build-owned
`dist/cli/acpx-runtime-sidecar.cjs`, which product code hashes and the runner verifies at launch. The
harness builds a stand-in runner package under `<repo>/node_modules/.restart-chaos-<wave>/`. It is all
symlinks to the real package, except that `dist/cli/acpx-runtime-sidecar.cjs` is a generated stand-in.
It lives under the workspace `node_modules`, so the provider package root that product code derives from
it is the same workspace root. A server hook loads only `runnerd-codex-transport` (`src/live/*.ts` from source, `dist/live/*.js` when built), the
module that computes the local sidecar path from its own URL, from the stand-in package. That module's
imports still resolve to the real package. The runner then verifies and launches the stand-in. The
stand-in installs the tap and runs the real sidecar bundle in the same process, as the runner's
verified CommonJS loader does. The tap wraps the stdio of the provider child that product code spawns
and admits, and the sidecar's own frames to the runner. Product code is unchanged. The stand-in
package is removed at the end of the wave.

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

**Q4** is Q1 twice in a row. The first answer wakes a resolved-interaction continuation run, and
that run saves the second question. A provider fault on a Q4 task takes the task's second matching
message (`occurrence` 2 in the rule): the interruption terminal of the second governed wait is late
(PV1) or lost (PV2). The wait must still settle without a failed or cancelled run. On a local Codex
runner the cancelled turn still settles inside the 30 s bound (waves w-20261111T151810-s111 and
w-20261111T152016-s111), so this cell does not by itself reach `native_governed_wait_settlement_pending`;
the run-dispatch adapter test covers that state's same-run resume. Staging run e892cf75 (2026-11-11) instead ended `cancelled` with
`execution_reconciliation_required`: the dispatch gate of the continuation treated the run's own
scheduled resume as a reconciliation hold, and the task stayed blocked with no Retry.

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads Q4 --faults PV2 --concurrency 1 --tasks 1 --seed 111
```

The Q4 oracle checks that two questions were asked and both were answered, that both asking runs
ended `succeeded`, that no run of the task failed or was cancelled, and that the brief carries both
answers. Q4 is not a default workload.

## Session replaced under a retained owner (SR1)

```sh
# One task: the parked question's warm owner is superseded before the answer.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local --lifecycle warm \
  --adapters codex --workloads Q1 --faults SR1 --concurrency 1 --tasks 1 --seed 301
# Two tasks on the same agent: one change supersedes both owners at once.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local --lifecycle warm \
  --adapters codex --workloads Q1 --faults SR1 --concurrency 2 --tasks 2 --seed 302
```

A session fault restarts nothing. It covers a staging failure class: a new run on a task whose
previous run left a warm Runner retained needed a new provider session, retired that owner first,
and failed with `provider_transport_failed: runner did not durably suspend before checkpoint`
before any provider work. A Q1 park leaves the owner with an unsettled question callback, the
condition that made its close unprovable.

The failure needs a Daytona task owner: locally a parked owner closes cleanly, so the local cell
passes before and after the fix and guards only the ordinary reset path. Run the Daytona variant
(`--env daytona --daytona-warm`) with an image that matches the checkout to exercise the
superseded-owner retirement itself.

SR1 runs Q1 with `--lifecycle warm` (or `--daytona-warm`). After the asking run settles and before
the board answers, the harness changes the agent's `adapterConfig.idleTimeoutMs` through
`PATCH /api/agents/:id`, as a user editing the agent would. That setting is part of the session's
configuration fingerprint, so the answer's follow-up cannot resume the saved session. The Q1 oracle
applies unchanged (`no_failed_attempt` and `issue_done` cover the follow-up), plus
`session_rotated_before_answer` and `follow_up_new_session` (a follow-up that resumed the saved
session would not exercise the retirement). Because tasks share their adapter's agent, `--tasks 2 --concurrency 2`
is the two-concurrent-runs variant. SR1 does not combine with K* or PV* faults.

### SR1U: the retained owner cannot be retired

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-warm \
  --daytona-image <image@sha256:…> --adapters codex --workloads Q1 --faults SR1U --concurrency 1 --tasks 1 --seed 311
```

SR1U is SR1 where the parked owner's stop stays unconfirmed even when forced. The harness boots the
server with `PAPERCLIP_TEST_WARM_RETIREMENT_FAULT=unconfirmed` (test instrumentation, armed only when
`NODE_ENV=test`, as in the harness server), so every retirement of a warm sandbox owner fails. This is the staging shape
where a follow-up failed with `Controller journal drain timed out` or `runner did not durably suspend
before checkpoint` before any provider work and nothing ever restarted the task. The follow-up must
fail once with `failureCause: native_predecessor_retirement_unproven`, re-queue itself in the
uncharged `interrupted_preparation` lane, and finish on a fresh sandbox restored from the saved
workspace. The Q1 oracle applies, except that this one pre-provider failure is not a failed attempt,
plus `predecessor_unretirable_fell_back` and `follow_up_fresh_sandbox` (the succeeding follow-up ran
on a different sandbox than the asking run). SR1U needs `--env daytona --daytona-warm`, and it arms
its fault for the whole server, so it does not share a wave with SR1.

## Re-wake after success (W2, W2Q, W2C)

```sh
# Ten tasks on one Codex agent with warm sandboxes; each task is woken again 0–60 s after its run succeeded.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-warm --daytona-cpu 3 \
  --adapters codex --workloads W2,W2Q,W2C --faults K0 --concurrency 10 --tasks 10 --seed 5201
# The same locally (warm local Runners).
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local --lifecycle warm \
  --adapters codex --workloads W2,W2Q,W2C --faults K0 --concurrency 10 --tasks 10 --seed 5101
```

In one 8-hour staging window (2026-11-11), 20 of 25 failures happened with no restart at all. One agent had
10–13 runs at once on reused sandboxes, and 30–60 s after a 20–43 minute run of a task succeeded, an
ordinary wake (`issue_commented`, `issue_monitor_due`) started the next run of that task. That run had to
retire the previous run's warm owner first, and failed before any provider work: `Controller journal drain
timed out`, `runner did not durably suspend before checkpoint` (class C+), or
`journal_tool_input_unanswered` after a predecessor that ended on an unanswered question (class C3).

The workload is the fault, so these cells usually run with `--faults K0` (no fault). Every task of an
adapter runs on that adapter's one agent: `--adapters codex --tasks 10 --concurrency 10` is ten tasks on one
agent. Phase 1 ends with the task left `in_progress` (`in_review` would gate completion on a review): the W2 and W2C
brief asks the agent to report phase 1 with `paperclip_finish` disposition `yielded` and a `response_wake`
continuation, because an agent that reports `done` closes the task and the wake is never sent (on 2026-11-11 four of
eight Claude cells tested nothing). A passive board wait needs a run that a board comment started, so W2 and W2C
create the task in `backlog` and start phase 1 with a board comment; without it the yield queues an immediate
continuation and phase 1 wakes itself. Then the harness, as the board, wakes the same task the
seeded 0–60 s after that run settled (`rewake.ts`):

- **W2**: a board comment, or, by the task's nonce, a board-scheduled issue monitor due now, so the
  scheduler's own `issue_monitor_due` wake starts the run.
- **W2Q**: phase 1 asks one `request_human_input` question and parks. A board comment (a note to include,
  not the answer) wakes the task while the question is pending. The board answers after that run settled.
- **W2C**: as W2, and first the board changes the agent's `adapterConfig.idleTimeoutMs` (sending the whole
  `adapterConfig` with `replaceAdapterConfig: true`, as the agent settings form does), so the next run
  cannot resume the saved session. SR1 (`session-faults.ts`, #20844) is the same change while a question
  is parked; W2C is the change after a run succeeded.

Until the wake is served (and, for W2Q, answered), the task waits on the board: not a rest, no Retry. The
oracle checks that phase 1 succeeded, the wake was sent and a run created after it succeeded,
`no_failed_attempt` (no run of the task failed or timed out), the task is `done`, and the brief's markers.
A task left blocked gets the usual Retry (R3), which fails the grade. A restart fault (for example K2)
may also join; it lands around the first run or the wake.

Add `--long-turn-minutes 20` for staging's long predecessor turns.

## Fail the Nth recovery step (`--fail-recovery-step`)

```sh
# Local: K1, then the replacement's first runnerd start fails once (spawn EAGAIN).
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local --adapters codex --workloads A1 \
  --faults K1 --fail-recovery-step runnerd-start:1 --fault-after-seconds 10 --concurrency 1 --tasks 1 --seed 5303
# Daytona: K1, then the replacement's first sandbox teardown does not finish.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-cpu 3 \
  --adapters codex --workloads A1 --faults K1 --fail-recovery-step teardown:1 --fault-after-seconds 30 --concurrency 1 --tasks 1 --seed 5312
```

Every other fault hits the control plane once and lets recovery run. On staging the first fault was often
harmless and a later step failed: a bootstrap retry met a missing runtime asset, a reattach met
`Agent directory operation is already active`, a bounded retry met an unfinished teardown.

`--fail-recovery-step <step>[:<nth>]` lets the wave's first restart fault (K1, K2, K4, K6, K14, K15 or
RR1–RR3) fire normally. When that fault's replacement server starts, the harness arms one crash point in
fail mode: the nth hit of the point in the replacement throws, once, the error its real step throws. The
control line is bound to the replacement's pid (`pid=<n>`), so an old server still draining during a K15
overlap never counts hits, and the harness disarms it once the receipt lands, so a later restart (RR, K6,
another task's fault) does not fail the step again. `nth`
1 fails recovery's first attempt at the step, 2 its second, 3 its third. Steps:

| Step | Crash point | Error thrown | Environments |
| --- | --- | --- | --- |
| `runnerd-start` | `native.process_start.after_requested_before_spawn` | `spawn paperclip-runnerd EAGAIN` | local, Daytona |
| `teardown` | `environment.teardown.after_claim_before_destroy` | `sandbox teardown incomplete: provider destroy did not finish` | Daytona |
| `directory-lock` | `agent_directory.operation_lock.before_acquire` | `Agent directory operation is already active` (409) | Daytona |

Any other registered crash point name also works; without its own error it throws
`CrashPointInjectedFailure`. Hits count across the server, so with several tasks in flight the nth hit can
belong to any of them: run one task per wave to aim at one task's nth attempt. A step that recovery calls
only once is never reached with `nth` 2 or more, and the task fails `recovery_step_failed_once`. On
2026-11-11 an A1 task with K2 on Daytona never reached `directory-lock`: pick a workload whose recovery
collects remote agent files.

`runnerd-start:1` with K1 (seed 5303) found the recovery-chain gap on 2026-11-11: the first recovery
attempt (`resume_dead_runner`) failed its spawn, which persisted a scheduled same-run resume. The second
attempt then refused to continue the interrupted turn (`local_stop_unverified`: the newest launch request
had no process identity and no stop receipt), so the restored session reported
`provider_turn_lost_on_restore` and the run ended `native_provider_terminal_failed`. A scheduled resume now
proves on this host that the failed launch left no runner and no runner state, records that stop, and
continues the turn. The cell passes only when the task finishes with no failed attempt.

Every task the armed fault crossed gets two more checks: `recovery_step_failed_once` (the receipt in
`recovery-step-receipts.jsonl`; a step never reached tested nothing) and `no_failed_attempt`. The fault's
receipt in `faults.json` names the armed step (`recoveryStep`).

## Long turn (`--long-turn-minutes`)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-warm --daytona-cpu 3 \
  --adapters codex --workloads W2 --faults K0 --long-turn-minutes 20 --concurrency 4 --tasks 4 --seed 5401
```

Staging's failures followed turns of 14–43 minutes; every other workload finishes in a few. With
`--long-turn-minutes <n>` (15–60, opt-in), every task's first turn first runs n minutes of real tool work:
rounds of one foreground shell command each (about 90 s of hashing and sleeping, short of provider
shell-tool timeouts) that append `ROUND <i> <start> <end>` to a log in the working directory. The agent
saves the log as the issue document `long-turn` and then does its workload in the same turn
(`long-turn.ts`). Any workload and fault can take it; the task's time budget grows by n minutes. Two checks
join the oracle: `long_turn_rounds` (every round reported, spanning n minutes) and `long_turn_run_observed`
(the harness saw one run of the task last n minutes). Use `--fault-after-seconds` to land a fault late in
the turn. Waves get long and expensive: keep them small.

## Staging mix (`--workload staging-mix`)

```sh
# Smoke: 6 tasks, 5-minute turns, K15 overlap deploys at minutes 3 and 6.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-warm --daytona-cpu 1 \
  --storage s3 --ephemeral-server --workload staging-mix --faults K15 --k15-overlap-seconds 30-150 --mix-runs 5 --mix-queue 1 \
  --mix-minutes 7 --mix-turn-minutes 5 --mix-tasks 6 --mix-fault-spacing-minutes 3 --mix-arrival-cutoff-minutes 0 --mix-hold-minutes 2 --seed 7101
# Short form (about 1 hour, for fix-PR comparisons): 3 swaps 12 minutes apart with 8-9 minute overlaps, 5-15 minute turns, 15 runs.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-warm --daytona-cpu 1 \
  --storage s3 --ephemeral-server --workload staging-mix --faults K15 --k15-overlap-seconds 480-540 --mix-runs 15 --mix-queue 3 \
  --mix-minutes 40 --mix-fault-spacing-minutes 12 --mix-turn-minutes 5-15 --budget-cents <cap> --seed 7102
# The same short form locally (agents on this Mac, so 10 runs). `--ephemeral-server` runs only on Daytona, so it is left out.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local --storage s3 --workload staging-mix --faults K15 \
  --k15-overlap-seconds 480-540 --mix-runs 10 --mix-queue 3 --mix-minutes 40 --mix-fault-spacing-minutes 12 --mix-turn-minutes 5-15 \
  --budget-cents 5000 --seed 7201
# Full form (about 4.5 hours): 6 swaps 40 minutes apart, 15-45 minute turns, 30 runs and a queue of 6.
RESTART_CHAOS_DAYTONA_VCPU_BUDGET=<org headroom> node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona \
  --daytona-image $IMG --daytona-warm --daytona-cpu 1 --storage s3 --ephemeral-server --workload staging-mix --faults K15 \
  --k15-overlap-seconds 30-150 --mix-runs 30 --mix-queue 6 --mix-minutes 250 --mix-fault-spacing-minutes 40 --mix-turn-minutes 15-45 \
  --budget-cents <cap> --seed 7103
```

Staging runs many agents at once on reusable sandboxes, with long tool turns, subtasks, comments and Retries arriving
while a deploy swaps the server. Every other workload runs a few short tasks. The staging mix is a workload, not a
fault: it runs under any restart cell in `--faults` (K1, K2, K4, K15) or with `K0` (no fault).

**Tasks.** Each task (workload `SM`) runs on one of three agents, picked by `--mix-ratio` (default
`opencode=60,codex=25,claude=15`) in an interleaved order, so any prefix of the wave keeps the ratio. The models are
the qualified runner profiles: OpenCode with DeepSeek V4 Flash through OpenRouter, Codex `gpt-6.1-sol` and Claude
`claude-sonnet-5`. Each task does these steps:

1. A parent task (`--mix-subtask-share`, default 30%) first creates two subtasks, assigned to its own agent. Each
   subtask runs two rounds and saves its own ledger.
2. The task runs n rounds of one foreground shell command (90 s each, 45 ticks of hashing and sleeping), so the
   turn lasts its seeded length of `--mix-turn-minutes` (default 15–45). Tools run for the whole turn, so a swap lands
   mid-tool for some runs.
3. Each round appends `ROUND <i> <start> <end> <hash>` to `ledger-<nonce>.log`.
4. The task saves the log as the issue document `ledger`. A parent also adds the last hash of each subtask's ledger.
5. The task posts one `DONE-<nonce>` comment and marks itself done.

**Arrivals and the queue.** The first `--mix-runs` + `--mix-queue` tasks arrive 5 s apart. The rest arrive evenly,
with jitter, until the arrival cutoff: `--mix-arrival-cutoff-minutes` (default: the longest turn) before the last fault
slot ends (its time plus its longest hold), or before `--mix-minutes` ends when there is no fault. So every started task
can finish before the wave is graded, and a task that starts before swap N can still be running after swap N+1. Planned
tasks that never launched are printed and recorded (`unlaunched` in `staging_mix_arrivals_ended` and
`staging-mix-resources.json`); they are not tasks started. Subtasks are created by their parents at any time. The
three agents' `maxConcurrentRuns` split `--mix-runs` by the ratio, one run each first. The harness keeps runs plus queue
tasks in flight, so about `--mix-queue` tasks wait in Paperclip's own queue behind the running ones. `--mix-tasks` sets
the task count for a smoke; otherwise the count fills the arrival window. An arrival window shorter than the first burst is refused at
start, and a wave that started no task fails as a harness error.

**Faults.** The faults in `--faults` fire on the wave's own clock, one every `--mix-fault-spacing-minutes` (default
40, staging's deploy cadence) before `--mix-minutes` ends, cycling through the kinds. Each slot fires after the previous
one settled and at least one task is in flight; it hits every task in flight (`staging_mix_fault_slot` and
`slotCoverage` record how many). The tasks show fault `K13`, as storm
tasks do: the wave's clock crosses them. A slot that never fired because every task rested first fails the wave as a
harness error (`staging_mix_fault_slots_missed`). With `--faults K0` the tasks are `K0` and nothing fires.

**Follow-ups.** About half of the tasks (`--mix-follow-up-share`) get a board comment while a run is running. The
comment asks the agent to add `FOLLOWUP-<nonce>` to the ledger. It is held until the next overlap window, but for at
most `--mix-hold-minutes` (default 10), and it goes out before the last 15% of the planned turn. A failed post is
tried again on the next poll with the same `clientRequestId`. The overlap window comes from `setOverlapProbe` in
`staging-mix.ts`, which a swap driver registers. Without a probe, the window is any time a fault is in progress and the
server still answers (a K15 overlap). The timeline records `staging_mix_follow_up`.

When no run is active once the hold or the 85% point has passed (the agent finished early), the harness posts the
follow-up after the run ended instead. The task then waits for that post before it counts as finished, and the post is
graded like an after-end follow-up: `after_end_follow_ups_served` needs an agent comment after it and the
`FOLLOWUP-<nonce>` ledger line. The `follow_up_posted` detail says "after the run ended".

To aim a follow-up at the warm session's idle close instead, set `RESTART_CHAOS_MIX_FOLLOW_UP_AFTER_END_MS=<min>-<max>`
(for example `298000-306000` for the 300 s idle timeout). The harness then posts the follow-up that long after the
task's last run ended, `RESTART_CHAOS_MIX_FOLLOW_UP_COUNT` times (default 2), and waits for every post before the task
counts as finished. A failed post is tried again with the same `clientRequestId`. The task budget grows by one
maximum delay plus one turn per post. The grade check `after_end_follow_ups_served` needs every post, an agent comment
after each post and the `FOLLOWUP-<nonce>` ledger line. The timeline records `staging_mix_follow_up_after_end` with the
measured delay.

**Retries: hands-off first.** By default the harness never clicks Retry during the wave or the settle, so the product's
own continuation is what gets measured. A task that shows a Retry banner is kept under watch, not rested. Every banner
is recorded per task: when it first showed, how long it stayed, and the error code behind it, even when the task then
finished by itself. A banner is a defect, because the product goal is that it never appears. After the settle
(`--mix-settle-minutes`, default 15, after the last fault slot ends), each task that is still not done and still
offers Retry gets one click (`staging_mix_retry_after_settle`). The harness follows the click to rest for up to 15 minutes,
whatever the settle setting. A task that finished by itself during the settle is watched again until it rests, so its
record is fresh before grading. When the release-swap cell drives the wave, its own end-of-wave pass makes that one
click instead, and its issue reads also update the banner record. Both paths use `shouldClickRetryAfterSettle` in
`staging-mix-retry.ts`, which never clicks:

- a done task;
- a task with a scheduled retry (`scheduledRetry`, state `retry_scheduled` or a `nextRetryAt`);
- a task that was already clicked.

So no task gets two clicks. `--mix-retry-during-wave` restores the old behaviour: Retries
clicked during the wave, held until an overlap window as follow-ups are (`staging_mix_retry_in_overlap`).

**Results.** `staging-mix-results.json` and the first lines of `SUMMARY.md` give six lines, in this order:

1. `completed hands-off / started`.
2. `duplicated side effects: N tasks`, followed by `; evidence incomplete: M tasks` when a check could not read its evidence (such a check is never counted as a duplicate).
3. `Retry banner shown: N tasks`.
4. `Retry worked / Retry clicked`.
5. `extra turns`: runs that started after the task completed with no undelivered input.
6. `follow-up answered in a later run: n`, with the answering run's queued wait (p50 / max) and the time from the comment
   to the answering run's start (p50 / max). These runs are required, not extra turns; the waits are shown because a long
   one is a product concern (a person waits for an answer behind a full queue).

A task counts as completed hands-off when all three hold, read from fresh data at the end of the wave:

- its status is `done`;
- every check of its deliverable passes (ledger rounds, DONE comment posted, follow-up delivered, subtasks);
- nobody clicked Retry.

A duplicated side effect (`rounds_once`, `done_comment_once`, `completion_once`, `subtasks_once`,
`subtask_rounds_once`) is counted on the second line. It does not remove the task from the first line. A Retry counts as
worked when the clicked task meets the same completion rule. The banner list follows, then one read of
`GET /api/companies/:id/assigned-work-invariant` at the end of the wave: `violationCount`, `violations` by reason,
`agentsWithStalledSlots` and `openTasks`.

The summary also lists, by start time, every run that started after the task completed, under "Runs started after
the task completed" (`extraTurns`, with counts by wake reason in `extraTurnsByReason`). A run queued after completion
that never started is listed on its own (`queuedAfterDone`).

The grader takes comment delivery from the server's own record and does not decide it again. A comment that the server
judged delivered to an earlier run never becomes a run: its wake is cancelled or coalesced. A run that the server
started from a wake that carries a person's comment posted after the task's first run started (`wakeCommentIds`, the
wake payload's `commentId`) is a required run. This includes the retry of a failed attempt for the same comment. OpenCode,
for example, takes no input mid-turn, so a comment posted during its turn is answered by the next run. Such runs are
listed under "Follow-ups the running turn did not receive, answered in a later run" (`followUpsAnsweredLater`,
`followUpWaits`). An extra turn is a run that started after completion from a wake that carries no comment. A run
counts as having received its comments only when it started a provider turn (a `turn.submitted`, `turn.accepted` or
`turn.started` run event, `providerTurnStarted` in the wake evidence). When a run fails before any provider turn, its
comments carry to the next run that starts one: that run is the required run and may re-complete the task, and the
failed run is not an extra turn. Wake evidence without `providerTurnStarted` counts every started run as a delivery. The
server's delivery rule (`task_history.read`, cited evidence, child-result reads) is covered by the server's own tests.

`completion_once` stays the independent side-effect check. The first run that reported completion is always the
baseline. A later completion counts as a duplicate unless its run answered a comment as above. A `done` result that the
server rejected as incomplete is not a completion: the server shows the rejection by queueing a same-agent continuation
wake with key `native-completion-incomplete` for the issue, and the latest accepted result before that wake is the
`done`. A wake that follows a later result, such as a `yielded` one, does not reject an earlier `done`. Such a run counts only when it posted the
DONE comment itself. Otherwise the continuation run that finishes the work is the baseline.

The completion time comes from the product's own record, in this order:

1. the earliest accepted run result whose `reportedWorkDisposition` is `done`, skipping a rejected `done` as above;
2. the issue's `completedAt`;
3. the first bare `DONE-<nonce>` comment, only when neither exists.

Each line prints the DONE comment time too when it differs, and gives the run's wake reason, source, trigger and
requesting actor from the saved wake evidence. A bare DONE comment posted by a run whose accepted result was not `done`
(for example `blocked` while a parent waits on its subtasks) is reported on its own, under "DONE comment posted before
the task completed" (`doneBeforeCompletion`).

**Grade.** The usual R1–R6, U1–U5 and T rules apply. A needed Retry still fails R3. The T-oracle checks the result,
not the status:

| Check | Fails when |
| --- | --- |
| `issue_done` | the task is not `done` |
| `ledger_rounds_verified` | a round is missing, ran under 80 s, or its hash differs from the harness's own computation (POSIX `cksum`, chained per tick) |
| `rounds_once` | a round line appears twice (a tool ran again) |
| `done_comment_posted` | no comment's whole body is `DONE-<nonce>`; a summary that quotes the marker does not count |
| `done_comment_once` | that comment was posted more than once |
| `completion_once` | more than one run completed the task (a duplicate completion), or the comments could not be read. A run completes the task when its accepted result has disposition `done`, or when it posts a comment that mentions `DONE-<nonce>` at or after the completion time. Without accepted results in the wave evidence, the bare DONE comment counts instead. A progress or blocked comment that says it will post the marker later is not a completion |
| `follow_up_posted` | a planned follow-up was never posted (the detail lists the post errors) |
| `follow_up_served` | a follow-up was posted during a run and the ledger lacks its line |
| `subtask_<k>_done`, `parent_read_subtask_<k>` | a subtask is missing, not done or its ledger fails, or the parent did not report its last hash |
| `subtasks_once`, `subtask_rounds_once` | a parent created more than two subtasks, or a subtask repeated a round |

Duplicated side effects (a repeated round, comment or subtask) fail the task and show in the signature.

**Resource guard.** The servers run on this Mac and the sandboxes are remote. `--mix-runs` above the local run cap
is refused: `--mix-run-cap` sets the cap, or `RESTART_CHAOS_MIX_RUN_CAP`, default 30. Every 30 s the harness samples
these values into `staging_mix_resources` in the timeline:

- its own process tree's memory (RSS) and CPU;
- the host's available memory (macOS `vm_stat`: free, inactive, speculative and purgeable pages);
- the 1-minute load average;
- the number of tasks in flight.

New tasks wait while available memory is below `RESTART_CHAOS_MIX_MIN_FREE_MB` (default 3072). The peaks are
in `<wave>/staging-mix-resources.json`. On Daytona, the run, the queue and about 5 minutes of idle warm sandboxes
(`--daytona-warm`) must fit `RESTART_CHAOS_DAYTONA_VCPU_BUDGET` (default 40). Raise it only to the org's real
headroom: the org is shared with the live fleet. Cleanup is the usual cleanup. The wave deletes its environment
through Paperclip, the instance with every test task is removed at the end, and nothing reaches a real company's
inbox.

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
Each one runs `update heartbeat_runs set updated_at = updated_at` on each of the wave company's
`running` rows, one row per statement, back to back. One row per statement matches a run-log
append; a statement over every running row locked several rows at once and deadlocked with
product transactions (40P01), which a real stream never does. No value changes, but every statement writes a new row version, which is what a
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
locally, and the current READ COMMITTED writer (`persistUsageReceipt`) committed all 8.

Live waves on 2026-11-10 (command above, codex and claude, four tasks each):

| Wave | Build | Receipt write 40001 in the server log | Tasks passed | Failures |
| --- | --- | --- | --- | --- |
| `w-20261110T040531-s20385` | #20385 parent `bf818280f2` | 117 | 1 of 4 | `adapter_failed`: 40001 exhausted in `createRunUsageRecorder`, `reserveRunBudget` and native finalization |
| `w-20261110T044338-s20385` | master `8004ad069e` + harness | 2 | 1 of 4 | `adapter_failed`: 40001 in `createRunUsageRecorder`; deadlocks with the old multi-row writers |
| `w-20261110T050818-s20386` | same build, one-row writers | 0 | 0 of 4 | every first run failed in `reserveRunBudget` before spawn (the log keeps only the failed SQL, not its cause); each accepted Retry then waited on `process_identity_missing` and never started a run |

No wave reached the runner's commit stall (20 failed deliveries over at least 45 s), so none showed
`native_event_replay_conflict`: on the parent a receipt write failed 117 times but a later delivery
committed. #20385 removed the receipt-write failures; the other repeatable-read accounting writers
that lock the run row still fail under the same contention on master. The contention check
(`contention_produced`) fired only on tasks whose runs failed before any usage was reported; a run
that finished produced 208 log events and 20 receipts, well above the 40 and 6 thresholds.

## Time faults (TM1–TM3, `--time-age-hours`)

```sh
# Freeze, sleep and aged outage across running tasks.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads A1,C1 --faults TM1,TM2,TM3 --concurrency 2 --tasks 3 --seed 301
# The aged wait: an approval left pending for a day across a restart.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads G1 --faults TM3 --triggers approval --concurrency 2 --tasks 2 --seed 302
# Staging's 100 s event-loop stall: TM1 on Daytona, stalled during workspace preparation or mid-tool.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env daytona --daytona-image $IMG --daytona-cpu 3 \
  --adapters codex,claude,opencode --workloads A1,T1 --faults TM1 --tm1-hold-seconds 70-120 --storage s3 \
  --concurrency 3 --tasks 6 --seed 303
```

TM1 also runs on `--env daytona`. It stalls only the control plane, with no
restart and no new deployment identity. The remote Runner keeps working while
every controller lease of the stalled process lapses. This is staging's class L:
a server stall of about 100 s at 08:19Z on Nov 10.

`--tm1-hold-seconds <n>` or `<min>-<max>` (10–600 s) replaces TM1's default
95–150 s range. It uses the same single draw, so seeds keep their cells.

To stall a run while it is still `preparing`, use `--fault-after-seconds`, as in
`--fault-after-seconds 10 --storage s3`. A stall while preparing needs a
preparation that outlasts the fault time, such as a remote workspace restore.

TM2 and TM3 age the wave database and freeze local runners, so they stay local.

The fourth fault family. Every other wave is minutes long on a fresh instance, so nothing time-bound
expires. A time fault makes deadlines lapse during a run or across a restart. No product code changes.

| Fault | What the harness does | Deadlines it crosses |
| --- | --- | --- |
| TM1 freeze | `SIGSTOP` the server process alone for 95–150 s, then `SIGCONT`. The runner, its provider and Postgres keep running. | Controller-instance lease (90 s), execution-control deadline (60 s), legacy run lease (60 s). The runner keeps calling a server that does not answer. |
| TM2 sleep | `SIGSTOP` the server and every process under it for 20–45 s. While they are stopped, shift every database timestamp back by the age. Then `SIGCONT` the same processes. | Everything stored in the database: native and remote execution leases, scheduled retries, liveness and silence watchdogs, accounting closure, and pending waits. The pause itself is 20–45 s, not the age. A stopped process's monotonic clock keeps running (it stops only in a real system suspend), so in-process deadlines shorter than the pause, such as the runner's 30 s provider request deadline, also lapse. TM2 therefore stands in for a laptop that slept and for a long process stall at the same time. |
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

A process start (`process_started_at`, `controller_process_started_at`, and `processStartedAt` keys in
JSON) is not aged. It is part of a process's identity: owners compare the stamp they saved with the
start time the OS reports, and a real sleep never changes that. Aging it would make every live owner
look like a different process, a harness artifact rather than a lapsed deadline.

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

## Repeated restarts (RR1–RR3, `--rr-gap-seconds`)

```sh
# Each kind across running tasks.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads A1,B5,C1 --faults RR1,RR2,RR3 --concurrency 3 --tasks 6 --seed 401
# A second kill while an approval is pending.
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads G1 --faults RR1 --triggers approval --concurrency 2 --tasks 2 --seed 402
```

Every other fault restarts the server once. Real deploy loops restart it again 5–60 s after it comes
back, while it is still recovering the runs the first restart interrupted. An RR fault starts as a K1
(`SIGKILL` the server tree, start a replacement at once). After each planned gap, measured from the
moment the replacement reports healthy, it stops that replacement and starts another one.

| Fault | Restarts | Default gap after health |
| --- | --- | --- |
| RR1 double crash | K1, then one more `SIGKILL` | 3–20 s |
| RR2 crash, then graceful | K1, then one `SIGTERM` (as K2) | 3–20 s |
| RR3 crash loop | 3–4 `SIGKILL`s in all; the last replacement stays up | 10–30 s |

The gaps are seeded per task (`restartSteps` in `plan.json`), and drawn only for RR tasks, so the plans
of existing seeds do not change. `--rr-gap-seconds <n>` or `<min>-<max>` (1–300) replaces every RR
gap: for example `--rr-gap-seconds 5` for a short deploy-loop gap, or `30-60` for a slow
deploy loop. To stop inside recovery, use `--rr-stop-on recovering` (below). RR faults do not combine with `--storm-minutes`, whose faults carry no planned steps.

`--rr-stop-on recovering` replaces the gap: each follow-up stop fires on the first `/api/ready` poll
(every 50 ms, from the replacement's spawn) that reports `recovering`, the K6 phase poll. Use it to
land the stops inside recovery. In the first live waves `/api/ready` reported `recovering` only
15–80 ms before `/api/health` answered, and `ready` 0.25–0.5 s after it, so every gap from health
(even 1 s) landed after recovery. A replacement that goes straight to `ready` is stopped there and
records `ready`. The receipt records `stopOn`, and each follow-up entry has `gapMs: null`; only the last
replacement is waited on to health, so the earlier entries have no `healthyAt`. The first replacement (of the K1 kill) is also watched from its spawn, not from its health.

**Evidence.** Each stop and replacement (the first kill included) is recorded with its signal, planned
gap, stopped PID, the `/api/ready` status just before the stop (`recovering` means it landed inside
recovery), and the stopped, restarted and healthy times:
- in `<wave>/repeated-restarts/<faultId>.json`, also written when the sequence fails part way (the planned steps are recorded before the first kill, so a replay of a failed sequence keeps its gaps);
- in the fault receipt (`repeatedRestart` in `faults.json`, and in each failure's `startup-phases.json`);
- in the timeline (`repeated_restart_stop`, `repeated_restart_healthy`).

**Grading.** The whole sequence is one fault receipt, so it is one fault window: from the first kill to
the last replacement's ready. Crossing, R1's outage allowance, R5's ready clock, the T-oracle, task
deadlines and the restart-recovery speed budget treat it as one fault. No check is relaxed: the task
must reach its correct terminal state with no Retry (R3) and no duplicated work (R4). The observer does
not click Retry and no other fault fires until the last replacement is ready. A `--replay` of an RR
task restarts again after the same gaps. A replacement that exits on its own during a gap fails the
fault as a harness error, with the stops so far recorded.

## Two servers, one database (MS1–MS3)

```sh
node cli/node_modules/tsx/dist/cli.mjs tests/restart-chaos/main.ts --env local \
  --adapters codex --workloads B5,Q1 --faults MS1,MS2 --concurrency 1 --tasks 3 --seed 301
```

Every other fault runs one server per wave, so no wave can reach a race between two servers. #20508 fixed
one such race with a database test only: server B's orphan sweep failed a run whose owner, server A, had
taken its lease back.

**Why this shape.** Hosted Cloud deploys by rolling overlap on one Neon database. The new server B starts
while the old server A still serves, then A drains. The defaults are a 5 s overlap and up to 90 s of
drain (`doc/plans/2026-10-31-zero-downtime-web-deploys.md`). B's startup recovery and periodic sweeps
therefore run beside A's live runs. The plan's K12 names the same overlap
(`doc/plans/2026-11-06-control-plane-restart-chaos.md`). This repository has no replica count or deploy
strategy of its own (`docker/ecs-task-definition.json` describes one task), and the self-hosting docs do
not describe several servers on one database.

| Fault | What happens | Seeded hold |
| --- | --- | --- |
| MS1 | B boots on the same database and stays up beside a live A for the hold, then gets SIGTERM. A is not touched. | 60–150 s of overlap |
| MS2 | B boots. A and its process tree are frozen (SIGSTOP, TM2's freeze without aging) past the 90 s controller lease, then thawed. B stays up 30 s more, while A takes its leases back, then stops. | 100–150 s frozen |
| MS3 | Rolling-upgrade shape. B boots, then A gets K2 (SIGTERM) and a replacement on A's port. B is the only live server until the replacement is ready, then stops after the hold. | 20–45 s tail |

B shares A's database, instance directory, local storage and secrets. It listens on its own loopback port
and writes `<wave>/server-b.log`. The harness and the agents keep using A's port. While a fault is in
progress the observers hold board actions (Stop, answers, follow-ups) until it ends, as for every fault.

Limits:

- B runs on the same host and PID namespace as A. It can check A's PIDs directly, which a Railway
  replica cannot, so these faults are a lower bound on cross-server exposure.
- The native executor lease is 20 minutes. MS2 outlasts the 90 s controller lease, not that one.
- Local only: a remote runner is under neither server. No storm, crash point, K14, TM2 or TM3 in the same wave (aging would move the database times the invariant compares with real process windows).
- B must live through its whole window. If it exits on its own, the fault fails (its tree is still cleaned up).

**Cross-server invariant** (`multi-server.ts`, `<wave>/cross-server.json`). It is checked once per wave
that fired an MS fault, over the wave database and the process windows the supervisor recorded (each
server's pid, start, exit and freezes). A violation fails the wave.

- `MS_foreign_failure`: a run failed with `process_lost` or `native_execution_ownership_unverified` while
  its owning server was alive and not frozen. The owner comes from the run's controller boot id and
  `controller_instances.pid`. The time is the run's `finished_at`. A freeze before the write does not
  excuse it: that is #20508's shape. A run still `running` with
  that code (how #20508's marker is stored) counts at its `updated_at`. The owner's own
  `controller_lease_lost` counts only when no freeze past the lease came before it.
- `MS_double_executor`: a run recorded a second local runner identity
  (`native.process_identity_recorded`) before the first was shown stopped (`native.local_process_stopped`).
  Sandbox identities (`targetKind: "remote"`) are not graded: the server records stop evidence only for
  local processes, so every in-run sandbox relaunch would look like a second executor.
- Ownership failures whose owner is not a wave server (or is unknown) are listed as `unattributed`.

The usual R1–R6, U1–U4 and T checks grade every task as before. In the speed grade, MS1 and MS2 take no
restart-recovery sample (the primary never restarts; MS2 does when the primary exited after the thaw and was
replaced), MS3 is timed from the primary replacement's readiness, and only the time the primary could not serve
counts as outage.
