# Discord command-registration scheduling audit

Parent: tool-health PR #17554, head `da4089960619d3da2112a4eed3cc7a3d97dbebf8`.
The parent has 771 selected passing local tests, passing workspace typecheck and
build, passing Actions checks, and fresh Greptile 5/5. Paperclip Review completed neutral with a 4/5 assessment and follow-ups for
company fairness and real-producer coverage. It is not accepted or merged. This branch owns
one newly separated reason from the existing chat-runtime inventory.

## Evidence and boundary

At the parent revision, `app.ts` calls `reconcileProviderRuntimes` from its recurring chat maintenance
lane. That service discovers eligible Discord and Photon endpoints, restores
runtime ownership, and calls `discord/runtime-reconciliation.ts`. The latter
calls `reconcileDiscordCommands` before inspecting registered command state and
runtime capabilities. Thus removing runtime inventory polling without another
owner would also remove command-registration recovery.

The command protocol and authorization already live in
`chat-channels/discord/commands.ts`. Durable state is in existing `chat_actions`
with kind `discord_command_registration`, owned by
`chat-discord-command-registration-store.ts`. The store already has retryAt and
retryIndefinite outcomes. A registered receipt has an existing five-minute remote verification deadline;
retain it while eliminating intervening discovery scans. An indefinite hold
must not cause periodic discovery simply because an endpoint is configured. Inspect the full
state protocol before deciding which attempted/unknown states may replay.

This slice should give command registration its own committed-change/deadline
worker and remove command reconciliation from recurring runtime maintenance.
Keep provider protocol, native identity/credential fences, and command receipt
validation in the Discord owner. Do not copy command HTTP behavior into startup
or the generic scheduler. Keep direct setup/foreground calls compatible.

## Required producer and lifecycle audit

- Endpoint creation/configure/reconnect/resume, identity/guild changes, credential
  rotation, removal, and connection disable/health quarantine.
- All registration-store claims, attempted/unknown/registered commits, recorded
  retry outcomes, legacy restoration, and operator force/reset paths.
- Existing registered command receipt publication and runtime capability refresh:
  establish a committed completion trigger without continuing a periodic scan.
- Shared receiver-ownership loss and lease contention: identify which operations
  require an owned runtime, a credential lease, or only an eligible endpoint.
- Configuration changes arriving during provider work must retain the existing
  generation/fingerprint fence and schedule the latest state after settlement.
- Startup reconstruction must discover missing registration state in bounded
  pages, without letting early failures starve later eligible endpoints.
- Empty, inactive, and indefinite-hold states must become quiet. Registered
  state must remain quiet between its existing five-minute verification deadlines.
  Due retries remain durable, respect Retry-After, survive restart, and retain
  deferred work through drain. Join admitted provider work at shutdown.
- Verify normal and ambiguous provider outcomes through the existing protocol
  tests; never replay an uncertain create merely to clear a scheduling blocker.

## Separate remaining duties

Runtime inventory discovery is still a separate migration. Its existing
eligibility is Discord/Photon, endpoint status verifying/active/attention,
active enabled connection, and no attention plus failed-health combination.
The shared receiver owner keeps a 15-second lease and renews an active listener
at one-third of its TTL. Those live-resource renewals are not empty discovery.
A standby must use the actual observed lease expiry for takeover, and local
ownership loss needs a callback that retains a wake after stop settlement.
Persistent transports remain host-sleep limitations even after discovery is quiet.

`app.ts` also invokes `chatChannels.voice.reconcile()` and Teams maintenance in
this lane. Voice, Teams, milestones, wake notices, terminal confirmations,
interaction continuations, and GitHub history recovery remain distinct duties.
The worker is now wired into application startup, and runtime reconciliation no
longer initiates registration. Runtime discovery and receipt projection remain
separate. Publication and remote acceptance gates are still pending.


## Implemented scheduling foundation, October 25

The store now exposes a normalized next deadline. A genuinely unowned namespace
is immediately due; valid receipts use their existing retryAt, including the
five-minute successful verification interval. Indefinite holds, malformed records,
foreign ownership and orphaned ownership tombstones remain parked. This is only
a scheduling hint: the existing protocol still rechecks current authority and
never adopts or recreates an unowned command. The shared retry parser and history
predicate keep the reader and mutation owner consistent.

Store-owned initial claims, receipt transitions, and retry-result updates await
transaction intent before writing. They emit endpoint-scoped hints through the
existing coordinator topic. No table or provider request was added to discovery.

`chat-channels/discord/command-schedule.ts` owns eligible Discord endpoint
selection and maps stored state to normalized deadlines. Startup/company discovery
uses UUID keyset pages of 100. Due checks reread current eligibility and saved
deadlines before calling the existing command reconciler, then reload the saved
result. Discovery checks shutdown cancellation between pages and rows.

`command-work.ts` uses the shared coordinator. It coalesces endpoint, connection,
or company hints; retains changes arriving during a pass; keeps passive drain
checks in memory; and dispatches at most 25 due endpoints per pass. Unsettled
attempts back off from 30 seconds to five minutes without being mistaken for
successful completion. Saved future deadlines remain authoritative. A provider
attempt already admitted at shutdown is joined through its durable settlement.

Verification: 36 real-PostgreSQL cases pass in
`chat-discord-command-registration-store.test.ts`, and server typechecking passes.
The cases include existing ownership/ambiguity/fencing checks plus saved deadlines,
indefinite holds, empty SQL quiet, quiet between verification deadlines, startup
reconstruction, disabled eligibility, nested rollback, first committed activation
during drain, no-progress backoff, and shutdown during provider I/O.

Two fixture failures were repaired without changing production assertions. The
foreign-owner deadline case initially violated the live-bot uniqueness constraint;
it now archives the first endpoint before creating the competing endpoint. The
empty inventory test inherited uncertain transactions from earlier fault cases;
its setup now reconciles those known prior test transactions before registering
the scoped worker. That preserves the requirement that real uncertain writes
must be reconciled before an instance can become quiet. Final evidence is in
`/tmp/sleep19-cancellation-tests.log` and `/tmp/sleep19-final-types.log` on this host.

## Integration checklist at the foundation checkpoint

- Wire configuration, readiness, provider failures, generic connection mutation,
  connection removal, and company deletion producers to the scoped topic. Audit
  all endpoint and connection writers; exempt metadata-only updates explicitly.
- Register the worker through the chat service, with existing standby, drain,
  startup and shutdown admission. Preserve direct foreground setup calls.
- Remove command reconciliation from runtime reconciliation only after that
  coverage exists; refresh a local runtime after successful command work through
  the existing runtime owner, without reintroducing command discovery polling.
- Exercise real configuration producers and affected chat/startup consumers, then
  run required workspace checks and publish the next stacked PR. Remote checks,
  reviews and final reconciliation with master remain mandatory.
- Continue every remaining original inventory item and unresolved earlier PR gate.
  This foundation does not finish this slice or the full goal.


## Integrated owner and verification

The production wiring and producer audit are complete for this slice; see
[the behavior and producer table](../idle-discord-command-registration.md).
The shared application wiring only registers the chat-owned command worker.
Discord scheduling policy stays under `chat-channels/discord/`; shared health,
access and deletion callers use neutral chat notification contracts. The existing
runtime reconciler no longer calls the command protocol. Direct configure/resume
calls remain unchanged, and the worker refreshes an existing local runtime after
command settlement through its current owner.

The actual configure/removal integration test proves a first configuration after
empty startup publishes its deadline, removal cancels it, and the removed worker
has no further reads or transactions. The real-protocol suite proves a committed
pause arriving during provider I/O is retained and eventually disarms the worker.
The parent health review identified company backlog starvation, and an equivalent
Discord worker regression failed before repair. Shared fair-batch selection now
gives each due company a turn, with a rotating cursor across bounded passes.
The isolated fairness helper commit is `e77979d4fc` for application to the parent.

Local final evidence:
- `/tmp/sleep19-fairness-after.log`: 41 tests pass (38 protocol/worker + 3 selection).
- `/tmp/sleep19-discord-isolated.log`: 91 selected Discord integrations pass;
  1,327 deselected cases are not counted as passes.
- `/tmp/sleep19-connection-consumers.log`: 487 tool-access/access tests pass.
- `/tmp/sleep19-startup-consumers.log`: 20 chat coordinator/startup tests pass.
- `/tmp/sleep19-workspace-types.log` and `/tmp/sleep19-workspace-build.log`:
  workspace typechecking and build pass before the final fairness addition.
- `/tmp/sleep19-fair-types.log` and `/tmp/sleep19-final-server-build.log`: final
  server typechecking and build pass after the fairness addition.

The initial integrated configuration test used a real timer before installing its
fake clock, then attempted pause while the endpoint was still verifying, and then
removed its fixture twice. Those setup/cleanup mistakes were repaired; no product
assertion was weakened. Repeated broad runs reused fixture data: inspection found
one paused endpoint for the unchanged hard-coded concurrent-identity test and two
retained contender comments for the unchanged global-body assertion. A fresh
schema-only database resolves that cross-run contamination. Dynamic registration
fixture IDs are now unique across processes, while ownership tombstones remain.

Next gates: publish the stacked PR, complete all remote checks
and reviews, repair the health parent's fairness and producer-coverage findings,
and propagate its changes. Full original inventory and earlier unresolved CI
remain required. No merge is authorized.


Review at 58a1ac7595 identified a failed-item capacity regression in the shared
coordinator and a quiet-window test that leaked spies on assertion failure. The
300-entry failure-backlog test reproduced 25 attempts; the repair honors future
worker deadlines while preserving fallback/backoff and drain. The integration
fixture now waits for active-work settlement as well as an empty scheduler and
always restores spies. Verification: 87 worker/coordinator/health, eight producer
and affected Slack, 57 existing lifecycle/startup tests; server types/build pass.
The health security parent is inherited through company cleanup. See the owning
Discord document for failure evidence and exact scope. Fresh remote gates remain.

## Idle assertion settlement repair

A descendant CI run (#17583, run 40184498387, server shard 11/12) observed one
scoped candidate SELECT during the rollback test's quiet interval. The test only
waited for nextWakeAt to become null. The coordinator consumes a timer before
its asynchronous transaction reconciliation and scoped load run, so null alone
can mean work is running, not settled. The test now waits for zero tracked active
work as well as no deadline before measuring the same 60-second zero-SQL interval.
No production timeout, dispatch, or quiet predicate was relaxed. All 41 real
PostgreSQL command ownership cases pass with the repair. Log:
`/tmp/sleep19-settlement-tests.log`. Propagate this owner-level change through the
stack; remote checks must verify the new heads.

## Current-parent follow-up, October 27

See [updated parent acceptance](../idle-discord-command-registration.md#updated-parent-acceptance-october-27)
for normal integration of the repaired health and company-cleanup parents,
127 targeted cases, corrected test selection, and the remaining remote gates.
The source duty and its 26-file scope are unchanged.


## Acceptance after the company-deletion parent landed, October 27

The branch integrates master at `f8563d25077b17681ab6ef5949f7b07415a58ede`,
including the landed health and company-deletion repairs. Squash ancestry caused
merge conflicts. Resolution applies only this slice's exact 26-file patch from
its recorded parent `21be75d2b0` to that pinned master. Every other file matches
master. The migration 0394 and current lockfile remain unchanged by this slice.

All 141 distinct targeted cases pass: 78 command-store, batching, coordinator and
startup-timing cases; 8 real automatic Discord and held-transaction Slack cases;
and 55 complete startup/export and company-deletion cases. The company-deletion
fixture starts on an initially empty isolated database and applies migrations.
The two Discord fixtures use separate migrated database clones. The remaining
1,581 chat integration cases were deselected. Server typecheck and build pass.
The startup suite retains the existing signal-listener warnings without an
assertion failure. Source files did not change after these results; subsequent
edits record this acceptance. No full local matrix or deployed sleep is claimed.
Fresh exact-head reviews and CI remain required before merge.
