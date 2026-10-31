# Native remote continuity regression

The opt-in case in
`server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts`
runs the real executor, PostgreSQL, TLS ingress, Rust runner, remote file transfer,
and backup validation against a deterministic fake Codex process in Linux. It
checks the same runner process identity and one provider process across three warm
turns, provider history reuse, and verified suspension at idle close. Separate
cases kill the actual controller process and recover the next turn. They reject
a still-live controller and a replacement sandbox before reconnecting. Legacy
checkpoints and changed process configuration require verified suspension and
replacement, while preserving the conversation and starting each turn once.
Recovery can restart a provider to refresh its tool contract; process reuse is
required for ordinary healthy follow-ups.
Each recovery case includes another healthy turn after the recovered turn and
asserts that it does not start another runner or provider process.
The same-server case also starts preparation lease renewal during recovery and
holds instruction collection open past a renewal tick after coordinator release.
The executor must acquire renewal before preparation releases its reference, then
stop renewal before releasing the coordinator. Completion must not detach the
retained runner or strand the next turn.
Buffered transport messages and close notifications can arrive synchronously on
subscription. The controller must register the connection before subscribing so
completed message processing can drain and the suspended session can retire.
It does not qualify a live model or a sandbox provider API.

Per-turn plugin continuation uses a stopped checkpoint on a replacement lease.
The executor tests cover Claude and Codex, including reopening blocked work.
The lease-authority integration test uses PostgreSQL to check that checkpoint
discovery cannot launch work or bypass a termination receipt. A stale negative
availability flag requires a fresh provider status before the checkpoint can
be read for continuation.

The executor can restore one quarantined journal in the same session scope.
It requires a terminal prior run, completed commands, a terminal event, and an
identity-matched suspended plugin checkpoint with no pending delivery or cleanup.
Multiple candidates, contradictory direct state, and unfinished work still fail
closed. Recovery preserves the journal and the provider's existing state owner.
Do not delete a quarantine or change database ownership to force continuation.

Use a disposable Linux container with Node.js, `sh`, `tar`, `base64`, `ps`, and
`setsid`. Build `paperclip-runnerd` and `fake-codex-app-server` from the checkout's
`packages/paperclip-runner/runner/Cargo.toml` for that container's architecture.
Keep the Linux runner binary on the host as well: the product hashes and stages
that artifact. Put the fake provider at `/opt/continuity/fake-codex-app-server`
inside the container. Do not put credentials in this container.

Start the container with `--init` and publish container port 43127 on localhost.
Read its assigned port with `docker port CONTAINER 43127`; an automatic host port
can change after a container restart. The test opens a local TLS tunnel to this
port. Create a test-only certificate and key:

```sh
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /tmp/continuity-test.key -out /tmp/continuity-test.crt \
  -days 1 -subj '/CN=localhost' \
  -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost'
```

Create an executable wrapper on the host at `/tmp/continuity-fake-codex`:

```sh
#!/bin/sh
if [ "$1" = '--version' ]; then
  echo 'codex-cli 0.999.0'
  exit 0
fi
exec /opt/continuity/fake-codex-app-server \
  --state-file-in-codex-home --durable-turn-ids --record-process-start \
  --call-log "$PWD/provider-calls.log" "$@"
```

Run the test with the container name, current host port, and Linux artifact path:

```sh
NODE_EXTRA_CA_CERTS=/tmp/continuity-test.crt \
PAPERCLIP_TEST_RUNNER_TLS_KEY=/tmp/continuity-test.key \
PAPERCLIP_TEST_RUNNER_CONTAINER=CONTAINER \
PAPERCLIP_TEST_RUNNER_PORT=HOST_PORT \
PAPERCLIP_TEST_LINUX_RUNNER_BINARY=/path/to/linux/paperclip-runnerd \
PAPERCLIP_TEST_FAKE_CODEX_WRAPPER=/tmp/continuity-fake-codex \
pnpm exec vitest run \
  server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts \
  -t 'preserves remote warm continuity' --maxWorkers=1
```

The caller owns the disposable container. Remove it after the run, including
after failure; failed cases can retain remote processes and files for inspection.
The test cleans up its database and host session directories.

## Replacing the main server

Remote native runners admitted with durable controller persistence tolerate up
to five minutes without the main server. The sandbox keeps its process, provider
turn and event outbox. Server-dependent tools wait for reconnection; work already
accepted into the queue resumes through normal admission. A single offline web
server cannot accept new HTTP requests during that interval.

Cloud operators can read `GET /api/instance/task-drain?upgradeReadiness=1`
with existing instance-control authority. The version 1 `upgradeReadiness` report
counts current remote executions with a bound current-format encrypted header and a live owner lease.
The checkpoint owner authenticates/decrypts that header and delegates version and identity
inspection to Runner; the identity must match the run, session and runner. Ordinary
sandbox runs bind their workspace identity; plugin tasks bind their active dispatched
environment lease and need no workspace-sync descriptor.
Legacy/local executions, missing identities/checkpoints, foreign/expired owners,
in-flight admission, and an incomplete census prevent a positive report. It
returns aggregate counts only. The request does not stop admission, detach a
runner, or authorize new work. Ordinary drain reads do not perform this SQL.
The explicit probe uses a read-only transaction, a two-second statement timeout,
and at most 1,001 run rows. Header reads are capped at 256 KiB each and 8 MiB total;
oversized, malformed, legacy-format or local evidence falls back to the ordinary drain.
This bounded header probe does not validate every journal record or prove a live sandbox. This is an observation; the existing shutdown and
startup owners still perform the actual handoff and enforce Stop and fencing.
A positive report alone does not prove hosted upgrade continuity.

Retain Postgres and the instance secret encryption key across deployments. The
private `native_runner_checkpoints` journal holds encrypted authentication state,
commands, and acknowledged event cursors. These records are company/run scoped
and are not part of public run projections. The replacement reconstructs its
local controller cache and authenticates the recorded running artifact, even
when its own installed runner binary differs. It does not stage a new binary
over the running process.

The runner package owns checkpoint encoding, validation, restoration, and command
classification. Its persistence callback exposes opaque records and explicit
ownership metadata. The server owns encryption and transactional lease checks;
heartbeat discovers eligible runs through the native runtime. Tool recovery uses
the current tool authority, including receipt decoding and read policy. Transport
adapters retain ownership of protocol response envelopes.

Checkpoint v2 stores authority, command records, a small cursor, and recovery
control events. It excludes ordinary `item.delta` output. `usage.reported` updates
are coalesced: only the latest one is included when a control change triggers a
checkpoint. Priority-zero events always retain their durability barrier. The
writer receives changed records, exact removed keys, and an initial replacement
flag and applies them under the owner lock. The format remains encrypted and
company/run bound. The decoder reads v1 as well as v2 checkpoints.

There is no event batching timer. Streaming text/usage does not call the external
checkpoint writer. Authentication, commands/results, semantic inputs, lifecycle
and other control events still commit before their acknowledgement or effect is
released. A failed control commit closes the connection, leaving the unacknowledged
input in the runner outbox. Remote controller caches also skip per-chunk file
writes; local-only controllers retain their full file journal. Existing application
event/log callbacks remain; this does not remove accounting or business writes.
Unknown event kinds retain the conservative persist-before-ack behavior.

Externally persisted controllers use Postgres as their durable store. Their
local file becomes a marker that requires restoration from the external
checkpoint before restart. Ordinary control changes do not rewrite a second
local journal. The sandbox runner keeps its own journal.

Checkpoint transactions share a separate pool capped at two connections per
server database client. They queue without occupying the application pool or
the existing lease-renewal pool. This can delay a control acknowledgement during
a burst; it does not release that acknowledgement before its commit. The cost is
up to two additional active database connections per instance, not per agent.
There is no new SQL per text chunk or while idle, and the number of control
transactions is unchanged. SQL cost collection must include the checkpoint pool.

A sparse checkpoint is marked `checkpointEventPolicy: "control-v1"`. Its peer must
advertise `recoveryCursorVersion: 1`. During reconnection the controller echoes the
runner's durable `resume.ackedSourceSeq` as `recoveryAckedSourceSeq` in the signed
authentication challenge. The runner verifies that exact value against its state;
the controller uses it only after client proof and current-owner admission pass.
The controller can then advance over already-acknowledged streaming output absent
from Postgres. It still requires contiguous new events and validates retained
replays. Unacknowledged output and control events replay from the runner's existing
disk outbox. No second remote journal or new polling loop is introduced.

The live event window keeps the latest identity, turn, result and usage anchors,
as well as unsettled semantic inputs, through long output streams. The 4,096-event
and 500-command limits remain. This checkpoint is intentionally not a complete
transcript. With local-only logs, an abrupt crash can lose a display projection
already acknowledged by the controller. The opt-in `s3_segments` log backend
checkpoints its canonical native export cursor in S3 and replays missing records
from the existing validated `heartbeat_run_events` source on takeover. This adds
no payload writes or per-record checkpoint transactions. Generic process output
and optional raw provider sidecars have separate durability boundaries. See
[run evidence storage](run-evidence-storage.md). The same provider turn continues;
recovery never reruns provider work to reconstruct display text. Tool outcomes
and terminal state retain their durable barriers.

Rollback must use a controller that understands sparse checkpoints and the signed
recovery cursor. A v2 decoder alone is insufficient. Runners admitted before this
release do not acquire the new protocol capability or grace period retroactively.

Completed checkpoints are pruned opportunistically at server startup using the
native harness backup enabled, dry-run, and retention-days settings (seven days
by default). This is a minimum retention age, not a deletion deadline: a record
that becomes eligible after startup remains until the next server restart.
The shared delivery coordinator drains bounded startup pages, retries failed
work, and preserves pending startup work across admission drain. It becomes
quiet after completing the pass, including when protected history remains.
The existing hourly filesystem sweep does not query database checkpoints.
The database pass also works with empty controller storage. A partial header index
keeps candidate discovery separate from event payloads and runs with no retained
checkpoint. Each page checks at
most 200 candidates and deletes at most 50 run checkpoints. It keeps checkpoints
unless every run in the session is finished and old, all related issues are old
and closed, finalization has settled, and no execution pointer, recovery owner,
live environment lease, or saved task-session pointer refers to the session.
Expiration locks finalizations and increments their controller generation before
deletion to fence late writers, including warm predecessors. Business records and
tool receipts remain. Closed sessions with saved resume pointers can therefore
outlive the retention age; age alone never authorizes deletion.

Expired-controller recovery reuses the existing orphan sweep's active-run
inventory. Checkpoint lookups occur only for native runs with an expired lease
and no tracked execution. There is no additional idle checkpoint scan; startup
recovery remains the first adoption path and the orphan cadence retries concrete
unowned active runs while ownership is unresolved.

Opportunistic checkpoint retention stops after three failed passes in a startup,
including candidate-query failures. It leaves retained rows intact, logs the
deferred work and becomes quiet. The next startup can retry; a persistent storage
or permission failure must not create an indefinite one-second database loop.

Plugin-owned workspace tasks use the same journal and recovery window. Their
task owner verifies the saved identity and running status through the task API,
then reconnects using the original active lease. It never fabricates a local PID
or submits another task during adoption. Shared recovery dispatches the task
claim; the plugin module retains task-protocol parsing and process ownership.
Local, SSH, and sandbox drivers retain their existing process identity checks.

Remote execution leases expire after 60 seconds and renew every 20 seconds.
Recovery grants that full lease from the database clock after locking the owner
row, rather than from an earlier batch observation before cleanup or other claims.
Fresh admission starts renewal immediately after its claim commits, before
accounting history, retained-session cleanup or other preparation. The startup
owner holds that same renewal through execution and drains it on preparation
failure; recovery retains its existing shared preparation/execution owner.
The local confirmed deadline starts immediately before the renewing UPDATE,
after connection and row-lock acquisition. A monotonic clock accounts for the
UPDATE/commit response delay without subtracting the earlier pool wait or
depending on synchronization with the database clock. Late responses cannot
restore a controller that has already lost local authority.
Graceful shutdown detaches and releases the lease. Startup and the existing
orphan sweep claim eligible expired owners; another container's PID is not
ownership proof. The runner reconnect window is seven minutes, providing margin
for the five-minute outage, lease expiry, and connection setup. Stop, company
scope and normal admission gates retain precedence. A completed tool receipt can
restore a lost response. Safe reads recheck current authority. An uncertain
external mutation is not executed again without outcome evidence.

Title and feedback recovery use their existing receipt owners, including their
normal input normalization and authorization. Semantic mutation recovery reads
under the same receipt lock as ordinary retries. Creation and reassignment
replay only their existing idempotent wake-up suffix after finding a matching
receipt; they cannot enter the mutation or cancellation path when a receipt is
absent. Monitor recovery uses the parsed input and preserves the saved deadline.
`tool-receipt-recovery.integration.test.ts` exercises lost responses, failed
post-commit dispatch, normalized keys, missing receipts, later title edits and
Stop, checking the independent business rows and audit effects before and after.

Instruction update/restore tools recover their existing `instruction:<callId>`
receipts through the instruction mutation owner. Recovery rechecks the current
target permission, active run and exact arguments under the normal receipt lock;
it cannot reserve or repeat a filesystem write. Missing receipts remain held,
including a receipt removed between inspection and locked replay. The real
Postgres/filesystem integration tests lose the commit acknowledgement for both
tools and verify one write, one audit effect, current-permission revocation and
Stop precedence. The optional `PAPERCLIP_TEST_DATABASE_URL` test host always uses
a new owned database, never its existing data.

The first rollout does not extend grace already configured in an old runner.
The contract starts with runners admitted by the updated server. Legacy stdio
adapters, database loss and destroyed sandboxes are outside this guarantee.

The empty-controller-cache test uses a real Rust runner and scripted provider
in separate directories, removes the controller directory, then restores solely
from Postgres. It checks unchanged runner/provider process identities and one
provider turn start. Build the host runner and fake provider first, then run:

```sh
PAPERCLIP_TEST_CONTROLLER_OUTAGE_MS=300000 pnpm exec vitest run \
  server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts \
  -t 'adopts the same runner from Postgres' --maxWorkers=1
```

This is protocol and persistence evidence. The separate
`everyday-workflows.runner-codex.daytona.recover-controller` Product E2E cell
qualifies the actual Daytona/provider path, including completion and workspace
finalization. Neither test substitutes for the other's failure boundary.

## Required native usage acceptance

Built-in native remote Runner execution accepts structured accounting before
its PRP transport ACK. `usage.reported`, turn-start, and turn-terminal facts
produce immutable `run_usage_receipts` rows. The receipt stores only structured
usage and turn identity. It does not depend on output logs or raw trace capture.
The source UUID derives from the run and Runner identity. Provider-turn IDs and
turn-start source facts preserve aggregation when several provider turns share
one PRP envelope turn. Source event IDs and
sequences remain stable across receiver replacement. Repeated delivery checks
the saved fact and does not create another receipt for the same report.

A failed receipt transaction rejects acceptance. The remote Runner keeps its
outbox report and reconnects through its existing protocol lifecycle. A lost
commit response can replay the same immutable receipt. A replacement receiver
restores accepted per-turn aggregation from Postgres, then accepts pending
reports from the same producer. The existing source fence prevents a retired
producer from replacing the current source's usage. Missing or partial usage
keeps accounting pending; it does not produce a zero-cost charge.

The native session authority epoch supplies the current run's accounting owner
to reused warm transports. The usual controller checkpoint and generation checks
still control transport acknowledgement and attachment. Ledger settlement,
pricing, reservations, and budget enforcement retain their existing owners.
No accounting receipt directory is created for this supported remote path.

Local native execution, legacy adapters, and external Dot/Muse execution retain
their existing recorder behavior. This change does not establish disposable-web
accounting durability for those paths. Server-originated model calls keep their
existing admission and settlement records. No S3 accounting spool is introduced.
The independent run-log/trace storage change can consume its own persisted
sources; output acceptance is not accounting acceptance.

Run the focused PostgreSQL/Runner experiment with:

```sh
pnpm exec vitest run server/src/services/native-runtime/native-usage-delivery.integration.test.ts --maxWorkers=1
```

The provider fixture emits a real PRP usage report through the durable Rust
Runner. A PostgreSQL trigger fails receipt insertion. The test removes the first
receiver directory, replaces its accounting owner, reconnects the same Runner,
and independently reads the receipt and ledger. The provider is controlled;
no paid provider request is made. Additional cases cover lost commit responses,
replay conflicts, per-turn aggregation, partial usage, source replacement, and
budget holds. Optional log and trace callbacks are absent from the experiment.

The cold fixture build runs before opening PostgreSQL, with the existing native
integration build budget. PR CI routes this suite through the existing cached
native Runner lane. CI builds the release fixture; local execution uses debug.
The behavior test has its own bounded receiver/process deadline after compilation.

### Codex usage authority and release order

The qualified Codex producer keeps its current-run baseline and latest session
totals in its existing durable provider state. It observes historical resume
snapshots, preserves that baseline across process recovery, and resets the
baseline to the latest totals when attaching the next run. Multiple request
reports therefore emit the whole run delta, rather than the provider's last
request. Regressing or incomplete live counters cannot certify completion.

Authoritative Codex reports carry `runDeltaBasis: "run"`. This requires a Runner
artifact built from the provider baseline implementation in this change. A
version string alone does not establish support; use the qualified artifact
digest. Existing unmarked Codex reports remain incomplete and unpriced in the
new accounting path. Their budget debt remains pending for reconciliation.
No deployed Runner artifact has been qualified by this source-only change.

PRP negotiates envelope versions and the admitted Runner digest. It does not
negotiate this usage payload field. The existing event envelope validators leave
usage payloads open, but an old standalone usage-schema consumer rejects this
new field. Update receivers and strict usage-schema consumers first, then
release the matching Runner artifact before claiming this durability guarantee.
Finish or explicitly reconcile older admitted Codex runs during cutover. Do not
claim that an old producer's final-request delta is a whole-run receipt.

Heartbeat completion reads the current immutable accepted receipt, including its
saved exact rate-card amount and provenance. It does not reprice with current
rates or replace that accepted estimate with an absent provider dollar amount.
The terminal UPDATE preserves the current producer-owned accounting projection
atomically. If another report arrived after completion read its checkpoint, the
newer receipt, readiness, price, and budget exposure win; unrelated session and
completion metadata can still update. A newer partial receipt stays pending.
Non-accounting attachment control events keep their existing handoff acceptance;
an old run's accounting report still cannot acquire a successor's authority.

The provider drains its bounded settled-turn usage tail before publishing the
terminal event that closes the run. An authoritative active goal keeps its
existing continuation path unless an uncorrected completion rejection closes
the run. The
same owner predicate selects both final usage drain and terminal outcome. A
completed turn remains authoritative after a
fully drained provider exit; ordinary session-exit handling still records an
unavailable process independently. This keeps a late cumulative increase on the old run before the
next run resets its baseline. Readiness and attachment retain accounting facts
in the existing provider checkpoint instead of discarding them, including facts
consumed before a later quiescence error. An increase
that arrives after authoritative completion requires explicit reconciliation:
PostgreSQL rejects changed finalized native usage or authoritative monetary evidence, so the existing Runner
outbox retains it under the old source identity without another charge. Equal
snapshots are harmless. No recurring scan or automatic adjustment is added.

If delayed usage arrives after attachment and cannot belong to the current
provider turn, the provider retains its cumulative evidence and the matching
saved prior identity, leaves the successor baseline unchanged, and emits a
failed run terminal. The existing reconciliation lifecycle blocks further work,
including after restart. Unknown older ownership stays explicit rather than
being inferred from provider-supplied run identity. Manual reconciliation or a
fresh session is required for this rare unsupported timing case.

Prior-turn increases are checked against the saved attachment baseline, even
when a successor has already reported a higher session total. Required usage
bypasses the optional diagnostic limit. An affected successor publishes an
explicit incomplete usage report before failure; this preserves known budget
exposure without settling ambiguous usage. That required report and its receipt
retain the accounting measurements and matching saved prior identity, so an
optional diagnostic acknowledgement cannot discard reconciliation evidence.
