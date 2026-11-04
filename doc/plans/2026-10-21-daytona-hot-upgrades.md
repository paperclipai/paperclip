# Daytona agents across server upgrades

## Goal and boundary

Upgrade the main Paperclip server while native agents keep running in their
existing Daytona sandboxes. A server outage of up to five minutes may delay
server-dependent tools and queued launches, but must not interrupt the provider
turn, create a replacement run, repeat completed effects, or require an operator
to pause admission. This chat delivers implementation and a tested, reviewable
PR. Production rollout is a separate endpoint.

The server is replaceable; Postgres retains coordination authority. The sandbox
retains the running process, provider session, and local event outbox. Durable
reconnection does not mean uninterrupted HTTP service while the only web server
is offline. Database loss, destroyed sandboxes, incompatible protocol changes,
and legacy server-owned stdio adapters are outside this first contract.

## Acceptance matrix

| Case | Required result | Evidence |
| --- | --- | --- |
| Active Daytona run, graceful server replacement | Same run, sandbox, runner PID/start identity, provider session and turn | Before/after identity and independently read receipts |
| Controller crash and empty replacement controller disk | Recover authenticated authority from Postgres; no duplicate provider start | Separate controller generations and unavailable original files |
| Five-minute outage during computation | Runner and provider stay alive; unacknowledged output retained and replayed | Real-process outage test plus persisted ordered events |
| Server-dependent tool pending across disconnect | Wait/reconcile without replaying an uncertain external effect | Tool receipt and invocation count |
| Completion during outage | Final result and workspace commit once after reconnect | Postgres result/finalization records and saved output |
| New work before/after replacement | Accepted queued work resumes automatically; no global pause required | Second run reaches useful completion |
| Concurrent old/new controllers | Only the current fenced owner may issue commands/ACK events | Postgres lease race and stale-writer tests |
| Existing runs and differing server/runner artifacts | Preserve admitted execution and runner identity; unsupported historical state remains explicit | Compatibility and artifact-identity tests |
| Explicit Stop and changed authority | Recovery cannot undo cancellation or bypass company/budget controls | Stop/reconnect and cross-company negative cases |

## Lean recovery revision

The per-output Postgres journal and its 20 ms batching timer are superseded.
Persist authentication, commands/results, pending requests, and lifecycle/result
events before exposing their effects. Streaming `item.delta` events do not enter
the recovery checkpoint. Usage updates are coalesced into the next control
checkpoint. The existing run-log/accounting paths remain their owners. Remote controller
cache files also skip per-chunk writes; local-only controllers retain their full
file journals. Control changes retain file and database durability barriers.

The runner already persists its acknowledged source sequence. Bind that value
into the authenticated reconnect challenge so a replacement controller can skip
previously acknowledged streaming output without pretending it retained those
bytes. Unacknowledged events still replay from the runner's existing disk outbox.
This is recovery of the same running agent, not a second durable transcript.
The runner must explicitly support this authenticated cursor contract; never
trust the unauthenticated hello or silently downgrade a sparse checkpoint.

| Outcome | Evidence required | Remaining work |
| --- | --- | --- |
| No recovery DB transactions during ordinary output streaming | 64 streamed chunks: zero external callbacks and unchanged controller cache | Passed |
| Empty-controller recovery across an output-only cursor gap | Both real-Postgres variants preserve runner/provider/turn across a 64-event cursor gap | Passed |
| Tool/result safety remains durable | 95 Rust durability tests; focused server and controller suites | Passed |
| Recovery state stays bounded and preserves current session/turn anchors | Full-window retention and warm-handoff controller tests | Passed |
| Five-minute outage still meets the original contract | First lean proof passed in 339.39 s; final cache optimization proof tracked in PR | Verification tracked in PR |

The tradeoff is explicit: the checkpoint no longer supplies a duplicate copy of
every displayed output chunk. Recovery-critical state remains durable; a crash
can leave a tail gap in display output not yet projected to the existing run log.
No provider turn or uncertain business operation may be restarted to fill it.

## Findings at kickoff

Base: `eaacadeba3`; worktree `/Users/dotta/.codex/worktrees/a2c4/paperclip`;
branch `codex/daytona-hot-upgrades`.

- Native graceful shutdown already detaches instead of cancelling provider work.
- `native_run_finalizations` stores controller ownership and recovery generations;
  `heartbeat_runs` stores admitted execution and session checkpoints.
- The actual runner transport's authentication leases, command journal and event
  cursor live in `control-plane-state.json` on the controller. Recovery explicitly
  rejects a remote run when that root is missing. Existing same-directory tests
  do not prove replacement-container survival.
- Remote runner and outbound ingress recovery windows are 120 seconds.
- Transport recovery constructs expected runner identity from the current binary;
  an upgrade must retain the admitted running artifact's identity instead.
- Controller takeover currently probes controller PIDs locally; this is not
  sufficient ownership proof across different containers.

## Architecture and delivery sequence

1. Retain the native execution lifecycle and PRP protocol. Add durable controller
   persistence at the transport's effect boundary: authentication, commands and
   control-event acknowledgements must be recoverable before becoming visible to the peer.
   Streaming output uses the authenticated cursor contract described above.
   Use a company/run-bound, versioned Postgres record with controller fencing;
   keep connection credentials encrypted with the instance secret provider.
   Local files become a materialized cache for existing parsers and diagnostics.
2. Restore that state before remote reattachment; retain the admitted runner
   artifact and execution input. Prove remote PID/boot/start identity through the
   existing sandbox probe. Never infer remote liveness from controller-local PIDs.
3. Give remote runners a recovery window covering the agreed outage plus bounded
   reconnection. Release controller authority on graceful detach and use bounded
   expiring authority after crashes. Preserve Stop and terminal-result precedence.
4. Qualify reconnect, command/event replay, empty-disk recovery and overlapping
   owners at the narrowest faithful layer. Then exercise the assembled server and
   a disposable Daytona run, followed by required repository checks and PR review.

First experiment: existing real-runner restart coverage with the controller state
directory unavailable to its successor. A same-PID assertion plus exactly one
provider `turn/start` distinguishes adoption from interruption-and-resume.

## State

Boundary revision requested after review of `1122b3f887`: keep checkpoint
encoding, validation, command classification, and filesystem restoration in the
runner package. The server persistence adapter receives opaque records plus run,
predecessor, artifact, and execution-command metadata; it retains encryption and
transactional lease enforcement. Tool receipt recovery moves behind the existing
tool authority and its revocable session epoch. Heartbeat asks native runtime for
expired recoverable runs without interpreting checkpoint storage markers.

These extend the existing persistence callback and tool authority rather than
introducing another provider abstraction. Local runners without a persistence
callback retain their existing path. Verify opaque checkpoint round-trips and
malformed persistence, receipt recovery under current authority, expired-owner
discovery, external drivers, and actual empty-controller process recovery.

Prior head CI/typecheck/build passed. Its initial review was 5/5; a delayed review
reported 4/5 for the API receipt shape fixed by this boundary revision. Both hosted
Daytona campaigns (39613279281 and 39616972414) stopped before sandbox launch
because the trusted image builder exhausted disk. That live acceptance gap
remains; this boundary revision does not change fleet settings or image workflows.

Implementation is in draft PR https://github.com/paperclipai/paperclip/pull/17097.
No production deployment has been performed.

Verified locally with real PostgreSQL and the Rust runner, using a scripted Codex
provider (not a live model):
- 125 controller protocol tests passed (`/tmp/daytona-core-final.log`).
- 84 affected server ownership/transport/shutdown tests passed
  (`/tmp/daytona-focused-server-tests.log`).
- Encrypted journal restore and stale-owner rejection passed
  (`/tmp/daytona-db-checkpoint-test.log`).
- Empty controller filesystem recovery passed, including a real 300-second
  outage, identical runner/provider PIDs and start identity, identical active
  session/turn, and exactly one provider turn start. The replacement did not have
  the old runner executable (`/tmp/daytona-five-minute-test.log`, 326.34 seconds).
  The fixture's initial missing simulated provider-home failure was corrected;
  that failed attempt remains in `/tmp/daytona-empty-disk-test.log`.
- Full workspace typecheck and production build passed.
- Real remote executor warm continuity and actual controller SIGKILL recovery
  passed against isolated Linux/Postgres, including three turns and idle close
  (`/tmp/daytona-remote-warm-final.log`, `/tmp/daytona-remote-hard-final.log`).
  Qualification found and fixed two journal ownership defects: the pre-attachment
  snapshot needs the current controller's successor lease, and each attachment
  must bind its writer to the new run. The first idle-close attempt also exposed
  the missing `runner.suspend` maintenance command. Those failed attempts remain
  in the preceding `/tmp/daytona-remote-*.log` files. A separate stale Docker
  port attempt was a test setup failure; the port is re-read after reset.
- 36 heartbeat recovery tests passed, including delayed lease expiry, Stop,
  and foreign-server shutdown (`/tmp/daytona-reaper-tests-final.log`). The first
  added-test attempt failed fixture FK cleanup after the assertions; cleanup
  now removes the finalization row before its run.

The final ownership implementation also passed the real five-minute repeat
(`/tmp/daytona-five-minute-final.log`, 323.85 seconds). External Dot/Muse driver
coverage passed 24 tests, including restoring an empty controller directory and
retaining the old running artifact without its executable. Review identified
same-server detach fencing and read-only API response recovery gaps. Detach
markers now identify each request and clear only after a settled predecessor and
verified recovery claim; lease-loss callbacks also match their exact lease owner.
Safe API reads re-enter the current tool authority. Same-server qualification
exposed a stale warm-cache override that could create an extra provider turn;
restart recovery now selects the Postgres run checkpoint. Its regression
intentionally corrupts the local warm projection and asserts one provider start.
The failed fixture attempts retained in `/tmp/daytona-same-server-*.log` include
controller-local artifact paths and incomplete remote workspace metadata;
`/tmp/daytona-same-server-review-final4.log` records the extra-turn failure. Copilot's source-bound identity moves to v54
while retaining v53 decoding compatibility. CI found two peer mocks missing the
new persistence methods; the corrected permission suites passed 27 tests.

Boundary revision verification:
- 147 protocol and external-driver tests passed, including opaque checkpoint
  restoration and rejection of missing, malformed, and misidentified records.
- 45 real-HTTP tool tests passed. The new recovery assertion exposed a pre-existing
  receipt representation mismatch (`operationId` versus `apiOperationId`). The
  tool authority now shares application-response conversion with live dispatch;
  the transport owns semantic-envelope construction for both paths. Encrypted
  receipts, disabled API access, and paused-agent rejection passed. The initial
  failure is retained in `/tmp/daytona-boundary-api.log`.
- 61 heartbeat and ownership regressions passed; 91 permission/Copilot tests passed.
- The real 300-second outage passed in 321.93 seconds with the same runner/provider
  and no old controller storage (`/tmp/daytona-boundary-five-minute.log`).
- Same-server stale-cache recovery passed three turns and idle suspension in
  disposable Linux (`/tmp/daytona-boundary-warm.log`, 28.13 seconds).
- Workspace typecheck and build passed. Initial sandbox-only socket tests and pnpm
  bootstrap were denied local sockets/network; the same commands passed with the
  needed permissions. The transport parity test initially compared a private
  callback marker; its public result/error assertions now pass.

Current-head CI and review must run after the boundary commit. Full hosted Daytona
acceptance remains blocked by image-builder disk exhaustion in both campaigns:
https://github.com/paperclipai/paperclip/actions/runs/39613279281 and
https://github.com/paperclipai/paperclip/actions/runs/39616972414.
Neither launched a sandbox. After supplying sufficient disk in the trusted image
builder, rerun only `everyday-workflows.runner-codex.daytona.recover-controller`.
Keep its empty-controller-cache fault and acknowledgement enabled. No third
unchanged campaign, shared fleet change, or production deployment was attempted.

Operational prerequisites: retain the same Postgres database and instance secret
master key across replacement. A first rollout cannot extend the reconnect grace
already baked into a runner launched by the previous release; the new contract
applies to runners admitted with durable controller persistence and the new grace.


## Integration with plugin-owned workspaces

Master added plugin-owned Runner admission in #16978 during verification.
The plugin task owner now uses the existing execution driver's adoption contract.
It verifies running status and exact durable identity, reacquires the authenticated
connection, and preserves the original task lease. It owns task protocol parsing,
stop confirmation, and credential/session settlement. Heartbeat dispatches the
recovery claim without interpreting plugin state. The environment orchestrator
continues to enforce current company, agent, run, workspace, and lease ownership.

The shared driver permits absent OS process identifiers for provider-owned tasks;
local and sandbox consumers keep their real process identifiers and probes.
Adoption uses the persisted running artifact and does not prepare or submit a
new process. Before attachment, the plugin owner reauthorizes the checkpoint's
configuration ID through the existing `check_project_auth` operation using current
project IDs, including when the IDs are unchanged but grants have been revoked.
The runner's optional adoption hook requires a configuration bound to the exact
execution; it does not require controller-local launch preparation files. Existing
consumers without that hook retain their preparation/authorization callback and
fail closed if its cache is missing. Ordinary launch and dead-process
recovery retain their existing preparation checks. A plugin run without the new
Postgres journal retains the historical recovery path.

The first focused run passed 147 tests and failed the new parameterized fixture
because it reused an issue identifier. The next run passed executor adoption
checks but exposed the fixture's missing explicit process owner and artifact.
Both setup defects are corrected; the real prepared-runner empty-disk case then
passed. Logs: `/tmp/daytona-plugin-focused.log`,
`/tmp/daytona-plugin-recovery-recheck.log`, and
`/tmp/daytona-plugin-prepared-recheck.log`. Initial typecheck failures from the new
claim variant and a test mock's narrowed option type were corrected in place.

The earlier broad matrix at boundary head `604395ce4c` completed all server,
serialized, UI, CLI, database, adapter, and plugin lanes, with four failures in
unchanged tests: Discord's child-process deadline, two CLI timeouts, and Gemini's
skill-root refresh timeout. The Discord file passed all 74 tests on an isolated
rerun; its identical base child script passed eight diagnostic runs. Both CLI
cases passed serially with their original timeouts. The full adapter/plugin lane
passed when rerun alone, including all 1,883 adapter-utils tests. No test or timeout
was changed for these retries. The initial causes remain unestablished; the first
matrix is not a clean pass. Evidence remains in
`/tmp/daytona-boundary-test-shards/` and `/tmp/daytona-boundary-recheck-*.log`.

GitHub's October 21 PR/webhook incident kept PR #17097 on old head `1122b3f887`
after remote branch `604395ce4c` was confirmed. Its old checks and delayed review
do not verify this revision. Current-head CI/review and hosted Daytona acceptance
remain separate requirements; no production upgrade has been performed.

The plugin-compatible revision passed 884 affected executor, task-owner, SDK,
lease, and restart tests, 180 durable protocol/Copilot tests, and 18 external
runner tests. Workspace typecheck and production build passed, followed by a
clean server typecheck after the final fixture edit. Logs are
`/tmp/daytona-plugin-regressions.log`, `/tmp/daytona-plugin-runner-regressions.log`,
`/tmp/daytona-plugin-external-regressions.log`, `/tmp/daytona-plugin-final-types.log`,
`/tmp/daytona-plugin-server-final-types2.log`, and `/tmp/daytona-plugin-build.log`.
The separate five-minute prepared-task run writes its result to
`/tmp/daytona-plugin-five-minute.log`; the PR records that final result.

The prepared-task five-minute outage passed in 322.32 seconds, preserving the
same real runner/provider and active turn with exactly one provider start.
The final heartbeat/workspace regression set passed 453 tests.
While these checks completed, master #17088 published Copilot v54 and v55.
The integration preserves both historical identities and binds this PR's
transport changes as v56. The only transport merge addition from master selects
the completion tool's bridge schema; this PR's recovery implementation remains.

## Recovery of API-backed tools

The fresh review of `da19b2871a` identified completed `comment_on_task` and
`write_task_document` writes that recovery could not find in the API receipt
store. Inspection found the same gap for `hire_agent`. The tool authority now
owns shared request conversion for live dispatch and recovery, including schema
normalization before receipt hashing and the existing response conversion.
Completed receipts return the original response without another HTTP write.
Missing, pending, or mismatched receipts remain unresolved; current run authority,
API enablement, and work-mode checks still apply. Safe task API reads re-enter
normal execution and authorization.

The first regression run reproduced both task-write failures. Its hiring case
instead failed because the fixture lacked explicit agent and responsible-user
creation grants; the fixture now establishes those grants. The initial evidence
is retained in `/tmp/daytona-api-alias-before.log`. The regression recreates the
authority after a real HTTP mutation and compares persisted effects before and
after receipt recovery, with missing/pending/changed-input, disabled-access, and
paused-agent cases.

All 2,048 real-HTTP, API-contract, and tool-authority tests passed after the fix,
including all three completed-write cases, and server typecheck passed. Logs:
`/tmp/daytona-api-alias-tests.log` and `/tmp/daytona-api-alias-types.log`.

CI at `84f80db58f` caught a recovery compatibility regression: normalized API
validation threw for an unknown operation where recovery previously returned no
recoverable result. Recovery now preserves that behavior for an absent API
operation while propagating other validation and authority failures. The broader
restart integration test covers this case. The hire regression compares stable
agent identity fields so asynchronous agent setup cannot affect its duplicate
creation assertion.

The same CI attempt also failed the unchanged browser draft-restoration test at
`board-attachment-receipts.spec.ts:358` (expected the full newer draft, received
`nding.`). That fixture assigns no agent and never starts a runner. The cause is
unestablished; its original job log is `/tmp/daytona-alias-e2e-job.log`. Runner
failure evidence is `/tmp/daytona-alias-runner-ci.log`.

The compatibility fix passed all 2,079 API/tool-authority and real-process restart
tests (five Docker-only cases skipped), plus server typecheck. This includes the
unknown-operation regression and the completed API-backed write regressions.
Logs: `/tmp/daytona-api-recovery-compat-tests.log` and
`/tmp/daytona-api-recovery-compat-types.log`.

## Checkpoint cost reduction after durable-harness research

The runner retains ownership of serialization and batching. Checkpoint v2 moves
the changing cursor out of the authority header and removes the historical key
arrays. Its callback supplies an atomic delta plus exact evictions; the server
keeps encryption and owner fencing. Ordinary events group at 32 events, 256 KiB,
or a 20 ms timer. Semantic input and priority-zero events remain immediate
barriers. No acknowledgement precedes persistence. This does not adopt replay of
unknown external effects, change provider process ownership, or add a workflow
service. Local journal writes and the application commit callback still run per
event; metadata mutations still capture the full bounded checkpoint.

The existing backup expiration owner also expires old, unreferenced checkpoints
from Postgres. It uses the existing maintenance schedule and settings. It checks
the whole session's runs, closed issues, finalization, environment leases, and
resume pointers before locking and retiring controller generations. It does not
need the old controller disk. Protected sessions remain retained beyond the age
threshold. Business history and receipts are not deleted.

On a fixed 4,096-event protocol fixture, the previous header is 54,460 bytes;
the new cursor is 79 bytes. For one new event with one eviction, changed plaintext
record payload falls from 55,281 to 900 bytes (98.4%). The eviction predicate uses
one removed key instead of 4,097 retained keys. A controlled 32-event burst makes
one checkpoint commit with 33 records instead of 32 checkpoint commits. These are
fixture byte and transaction counts, not production throughput, WAL, encryption
size, CPU, or cost measurements. Low-rate events may still commit individually.
Reproduce the size comparison with `PAPERCLIP_CHECKPOINT_COST_REPORT=1` and the
`keeps the checkpoint header` test in the runner package; use Vitest's
`--disableConsoleIntercept` to print the report.

Initial verification: 133 controller protocol tests passed; 60 Postgres/restart
and retention tests passed with five Docker-only cases skipped. Workspace
typecheck and production build passed. The first pnpm invocation failed to fetch
its pinned version, and sandboxed socket tests/typechecks were blocked by EPERM;
the installed pnpm 9.15.4 and explicit local-socket access resolved those setup
failures. Evidence: `/tmp/checkpoint-batch-tests.log`,
`/tmp/checkpoint-postgres-tests.log`, `/tmp/checkpoint-cost-comparison.log`,
`/tmp/hot-upgrade-cost-typecheck.log`, and `/tmp/hot-upgrade-cost-build.log`.
The five-minute proof, full suite, and current-head PR review are recorded below
when complete. Hosted Daytona qualification remains a separate outstanding gate.

Master integration for the cost update preserves published Copilot v56/v57 and
binds this branch's transport changes as v58. Master used migration 0371, so the
checkpoint table is regenerated as additive, idempotent migration 0372 using
master's complete snapshot. Both restart test faults remain: discard controller
cache for the explicit remote recovery cell and crash after result for the
finalization cell. They cannot be combined. The first full local suite was
interrupted to integrate these conflicts and is not recorded as a pass.

The optimized checkpoint revision passed the 300-second empty-controller-disk
prepared-task test in 322.93 seconds (`/tmp/hot-upgrade-cost-five-minute.log`).
The same real runner/provider process and active turn survived with one provider
start. This run started before the master merge. The merged branch subsequently
passed 62 Postgres/restart/retention tests with five Docker-only skips. A new
server integration fixture initially accessed runner-private store save methods;
workspace typecheck rejected that fixture. It now exercises the public opaque
checkpoint delta contract directly instead of expanding the production interface.

The merged protocol/transport suite passed 490 tests. Full workspace typecheck,
production build, and runner E2E typecheck passed. Final retention discovery uses
a partial index over checkpoint header rows (migration 0378), so it does not
need to enumerate event payloads or historical runs with no retained checkpoint.
Fresh Postgres verification with that migration passed all 62 restart, delta,
and retention tests (five Docker-only skips). Migration safety/numbering and
server typecheck passed; the final snapshot set is 0369 through 0373.
Logs: `/tmp/checkpoint-merged-protocol-tests.log`,
`/tmp/hot-upgrade-cost-final-typecheck.log`, `/tmp/hot-upgrade-cost-merged-build.log`,
`/tmp/hot-upgrade-cost-e2e-types.log`, `/tmp/checkpoint-final-postgres-tests.log`,
`/tmp/checkpoint-final-migrations.log`, and `/tmp/checkpoint-final-server-types.log`.

All 52 CI checks outside Greptile passed at `f8f9db0c48` (four intentional
skips). Greptile identified a recovery defect: a missing document during an
offline controller interval could fail the recovered transport. Known read
errors now return the same failed-tool envelope as live calls. The product tool
authority owns this classification; it rechecks its lease and run before
settling the error. Unknown failures, revoked authority, and uncertain writes
remain fenced. The new regression initially asserted `task` instead of the
existing `activeTask` response field; the assertion was corrected without
changing the production response contract. Logs:
`/tmp/checkpoint-recovered-read-tests.log` and
`/tmp/checkpoint-recovered-read-final-tests.log`.
The final restart, tool-authority, and API integration verification passed 110
tests (five Docker-only skips); server typecheck also passed.

The merged full local suite found four failures in unchanged tests: two chat
integration cases (ambiguous Slack retry and attachment-only Telegram failure),
a workspace port-conflict case, and a wrong-company gateway revocation case.
All four passed isolated reruns without source or timeout changes. Their
original causes remain unknown, and the full invocation is not a clean pass.
Original evidence: `/tmp/hot-upgrade-cost-merged-full-tests.log`. Rerun evidence:
`/tmp/checkpoint-unrelated-chat-recheck.log` and
`/tmp/checkpoint-workspace-gateway-recheck.log`.


Lean revision verification so far: 64 ordinary text events produced zero external
checkpoint callbacks, and a fresh controller directory recovered the authenticated
cursor before accepting event 65. Both real Postgres empty-disk variants passed
with 64 acknowledged chunks absent from the DB checkpoint, unchanged runner and
provider identities, one turn/start, and one post-restart steer. All 95 Rust
durability tests passed. Workspace typecheck and production build passed.
The first focused invocations selected the previous staged release binary; they
were interrupted (exit 130), then the current binary was built and staged before
rerunning. The first controller invocation also found an obsolete batch-close
hook after timer removal; that hook was removed before the 132-test passing run.
Logs: `/tmp/lean-controller-tests.log`, `/tmp/lean-rust-durable-tests.log`,
`/tmp/lean-postgres-empty-disk-fresh.log`, `/tmp/lean-workspace-typecheck.log`,
and `/tmp/lean-workspace-build.log`. The five-minute proof and broader revised
suites are tracked separately; prior-head CI is not evidence for this revision.


The lean protocol/transport suite passed 422 tests. A 300-second outage with the
controller directory deleted passed in 339.39 seconds total, before the final
cache optimization. After merging master `92cfd701c3`, all 69 Postgres restart and
retention tests passed (five Docker-only skips), and workspace typecheck/build
passed. An additional server recovery/tool run passed 87 tests, with 35 external
warm-transition-fixture cases and five Docker-only cases skipped.

The final cache optimization stops remote-controller file writes for ordinary
text/usage as well as Postgres checkpoint calls; the runner owns the durable ACK
and unacknowledged outbox. Control commits remain durable. Local-only controllers
keep their existing full file path. The policy persists through warm handoff.
The focused controller/permission suite passed 162 tests and runner typecheck
passed. CI at `66e980561d` exposed 21 permission-ordering timeouts: mocked peers
omitted the new recovery-cursor property, making their pump cursor NaN. Both
permission mocks now declare and implement that property; production fallback
behavior was not weakened. Logs: `/tmp/lean-ci-runner-failure.log`,
`/tmp/lean-final-controller-permission-tests.log`,
`/tmp/lean-merged-postgres-retention.log`, and `/tmp/lean-five-minute-proof.log`.
Fresh final-cache five-minute evidence, full-suite results and current-head CI
are recorded in the PR's Verification section rather than inferred from prior
commits. Hosted Daytona remains unqualified because its builder failed before
sandbox launch.


### Lean-design review follow-up

The final cache revision passed a 300-second outage with the controller directory
deleted in 327.36 seconds total. Logs: `/tmp/lean-final-five-minute-proof.log`.
Workspace typecheck/build also passed at `7ca5e0b890`.

Review found a stale Copilot v58 digest assertion and idle checkpoint scans. The
assertion now matches the generated identity; all 55 installation tests passed.
Recovery reuses the existing active-run inventory and queries checkpoints only
for expired, untracked native controllers. Empty/terminal inventories create no
extra query. Startup remains the first recovery path; the existing orphan cadence
retries only concrete unresolved active ownership.

Checkpoint retention is now explicitly opportunistic at startup, using the shared
delivery coordinator for bounded pages, failure retry, drain/resume, and shutdown.
Seven days is a minimum age, not a cleanup deadline. Protected or newly eligible
records wait until the next restart. This avoids adding notifications to every
run/issue/session/lease writer or a permanent cleanup scan. The original hourly
filesystem cleanup is unchanged and never queries database checkpoints. Live
ownership, saved resume pointers, and late-writer fencing remain protected.

The focused real-Postgres recovery/retention suite passed 70 tests, including
three former hourly periods with no additional DB reads for empty storage or
retained history, next-startup cleanup, and startup drain/resume. Logs:
`/tmp/lean-idle-recovery-retention.log`, `/tmp/lean-copilot-digest-tests.log`.

The final recovery/retention rerun passed 71 tests, adding a blocked-disposition
case so the reused inventory cannot overwrite native recovery's fresh decision.
Startup wiring passed 39 tests. A parallel retention invocation hit the existing
20-second embedded-Postgres setup timeout before tests; the subsequent isolated
rerun passed. Logs: `/tmp/lean-final-idle-tests.log` and
`/tmp/lean-startup-retention-tests.log`. Workspace typecheck/build passed after
startup wiring; final-head validation is tracked in the PR.

### Warm attachment ownership (2026-10-24)

Checkpoint record identity follows the attached PRP run. Its write lease follows
the currently admitted business run. These identities differ while a replacement
controller adopts a completed warm session before attaching the next turn. Both
plugin tasks and built-in drivers use the same registration helper, and a reused
backend resolves current authority when it registers instead of capturing the
previous run's lease. Losing that authority still fences subsequent writes.

The recovery integration suite accepts `PAPERCLIP_TEST_DATABASE_URL` for an
explicit disposable Postgres instance when native embedded Postgres is unavailable.
It creates and removes a fresh database for each invocation; it does not reuse the
URL's database as fixture storage. This option changes test setup only.

### Claim-to-attachment lease lifetime (2026-10-24)

A durable remote recovery starts renewal immediately after each claim commits,
before the remainder of the recovery scan, audit writes, or heartbeat preparation.
Preparation and the native executor share one timer for the same authority. Each
releases its own reference; failed scans release undispatched claims. Renewal
never queues behind a pending SQL operation and cannot revive an expired lease.
A lost remote authority detaches without stopping its sandbox execution.

The real-Postgres regression waits past the original claim expiry without editing
that lease, transfers the renewal reference to execution, and verifies a competing
controller cannot take over. Unit gates prove one renewal per interval and zero
SQL after the final release. The plugin adoption lifecycle fixture now uses the
current `adoptIdentity` contract and cleans up its owned database.

### Renewal isolation and bounded waits (2026-10-24)

Native renewal uses the existing two-connection liveness pool, shared per database
client with legacy controller renewal. It does not queue behind unrelated
application queries. Each attempt locks the coordinator row, then checks current expiry and performs
one fenced update in a transaction with a local 10-second statement timeout.
Checking after the lock prevents renewal from reviving an owner that expired
while the statement waited. A cancelled statement can retry on the next
20-second tick without extending the 60-second remote ownership deadline. No
overlapping attempts are queued. A missing response reaches the local deadline
and detaches authority; a late response cannot restore it. Final release stops
both timers and drains the in-flight attempt. Idle instances issue no renewal SQL.

This adds transaction, timeout-setting and row-lock statements around each
active lease update. It does not add text checkpoints or change the idle-SQL gate. The SQL cost
comparison for text chunks excludes periodic lease renewal, so it does not measure
this active-run overhead. Saturated-pool and row-lock tests use real Postgres;
clock tests separately exercise response loss, retry and shutdown.

### Current authority for retained resources (2026-10-24)

Review identified that bypassing preparation after controller storage loss also
bypassed its project authorization check. The runner now carries only the opaque
configuration ID and exact execution identity in its bounded control metadata.
The plugin adapter implements the new adoption authorization hook with its existing
project authority check before connection registration. Revoked grants, mismatched
identities, unsupported checks and a release during the check all reject adoption.
Successful authorization does not prepare, submit or stop the surviving process.
The same check is reused by the legacy preparation recovery path. This adds one
project authorization call per adoption and bounded control metadata; it does not
introduce periodic checks or text-triggered checkpoint writes.

### Checkpoint expiry after a row-lock wait (2026-10-24)

The checkpoint writer acquires the coordinator row in a locking CTE, then samples
`clock_timestamp()` in the outer query. Sampling in the locking query itself could
use a time from before an unchanged row-lock wait and accept an expired owner.
The regression observes the writer blocked in Postgres while its lease is still
valid, holds the unchanged row past expiry, and verifies the durable barrier fails
without changing the saved checkpoint. It fails on the prior writer and passes
with the fix. Both phases remain one SQL statement and database round trip.
The repeated 8/512-chunk cost gate still measures eight checkpoint writes, seven
transactions and fourteen changed rows, with zero streaming or idle SQL.


### Project creation receipt recovery

`create_project` stores its committed result identity in the existing
`project.created` activity receipt, scoped to company, actor, source task and
idempotency key. Recovery asks the normal authenticated project creation route
for that receipt with `X-Paperclip-Receipt-Only: true`. The route retains its
normal parsed input, fingerprint validation and access checks. It checks current
run authority again after acquiring the receipt lock. A matching receipt returns
the existing project. An absent receipt returns HTTP 204 before any project or
audit write; recovery holds the uncertain mutation. A missing key is rejected.
This adds no checkpoint table writes or recurring work during ordinary execution.

The real-Postgres/API regression loses the successful HTTP response after commit,
then uses fresh tool authorities to recover concurrently. It checks one project
and one audit receipt, input mismatch rejection, company isolation, cancellation,
and the no-receipt/no-effect path. The transport test separately checks the
receipt-only request and empty response. macOS skips the embedded-Postgres suite;
a passing transport test is not a substitute for its Linux CI result.
