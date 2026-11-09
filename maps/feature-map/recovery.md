---
navigation: {"section":"Projects and execution","sectionOrder":40,"order":50}
---

# Recovery

People can see why a task stopped, who owns the next action, and whether a safe
continuation is available. Recovery retains task context and ownership, honors
pause and budget gates, and distinguishes confirmed failure from an uncertain
external outcome. A retry acknowledgement alone is not proof that work resumed.

Feature ID: `recovery`.

Agent access: [companion](../agent-access-map/recovery.md).

## Sub-features

- `diagnosis`: `recovery/diagnosis` — a task/run exposes the recorded cause, evidence, owner, attempt
  progress, and next action without requiring a raw-log interpretation.
- `bounded-continuation`: `recovery/bounded-continuation` — supported interrupted work continues with preserved
  conversation context and bounded attempts, without blindly replaying tools.
- `source-action`: `recovery/source-action` — source-scoped recovery actions remain attached to the task;
  independent repair work may have its own issue and return owner.
- `exhaustion`: `recovery/exhaustion` — an exhausted infrastructure attempt offers ordinary Retry.
  Internal repair stays system-owned; genuine user decisions retain their
  specific action.
- `workspace`: `recovery/workspace` — workspace divergence/export failures show the applicable repair,
  reconcile, or isolated reissue action with evidence and authority checks.
  Retained-file recovery runs in the harness with observed task progress and a
  ordinary Retry action after exhaustion or during backoff. It preserves newer files,
  keeps uncertain sources held, and delivers saved human input through ordinary
  admission. The task does not expose infrastructure-certification forms or a
  workspace link when the destination is disabled. Local PostgreSQL and real
  filesystem regressions cover native and legacy recovery and one-time delivery;
  hosted provider recovery remains separate acceptance.
- `unknown-outcome`: `recovery/unknown-outcome` — uncertain external side effects require inspection and
  an explicit decision, not automatic replay.
- `user-continuation`: `recovery/user-continuation` — saved user messages after a stop are reconsidered once
  cleanup proves the old execution is stopped; duplicate wakes are avoided.
- `reconnect`: `recovery/reconnect` — browser stream recovery refreshes persisted state without claiming
  the agent itself restarted or that a failed run succeeded.

## How to get to it (user POV)

### `source-task`

Open the affected task from Tasks, Inbox/Blocked, search, or a direct task link.
Observe one working, backoff, failed or waiting-for-user state. Use Retry after
an infrastructure failure. No process or file certification is required.

Thinking appears immediately after Retry, before the request completes.
Technical source/run details remain in deliberate diagnostics. The
[task recovery contract](../../doc/task-recovery.md) describes receipt identity,
fresh workspaces, bounded retries, historical adoption and service incidents.

### `run-detail`

Open the agent's run (`/agents/:agentId/runs/:runId`) from activity or the task's
run link. The run page hosts workspace recovery controls only for a failed run
with error code `workspace_validation_failed` and a linked source task that still
has a live `workspace_validation` recovery action. Use the source task for other
stopped-run recovery checks.

### `operator-retry`

Use the task's Retry action. It can create an isolated attempt after old execution
is contained even when old-file preservation remains unresolved. Approval,
credentials, budget and deliberate pause use their existing specific controls.

### `post-stop-message`

After a stop, send a new instruction on the same task or inspect one already
saved while cleanup was pending. Observe the waiting message, continuation, and
eventual result rather than manually changing the task status to look complete.

A continuation denied before startup by an existing execution hold remains a
wait. Once the original hold clears, the server verifies the dispatch receipt
and absence of execution evidence, ignores any historical false incident for
that unused admission, and reconsiders saved input through normal admission.
No infrastructure-certification form is needed. The
[database regressions](../../server/src/__tests__/heartbeat-undispatched-execution-wait.test.ts)
cover incident prevention, retained audit history, concurrent restart admission,
ordered messages, contradictory execution evidence, and unchanged pause and
task gates. These tests do not qualify a live provider or prove task completion.

### `browser-reconnect`

While viewing an active or recovering task, interrupt the browser connection
and restore it, or suspend and return to the tab. Reload is a separate check.
The current task and run state should reconcile with the server.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey).
Use a disposable instance and reproducible failure. Record source task/run,
adapter/runtime mode, cause, attempt count, current owner, and verified stop
evidence. Do not kill an unrelated server or induce provider side effects just
to get a failure screen. Use the existing deterministic recovery suite first.

**Operation checkpoints**

Use these checks alongside the entry-point recipes below and the operation records in the [access companion](../agent-access-map/recovery.md). Record the actual actor, surface, saved result and denial separately. Source review and linked tests do not establish a live pass.

| Capability ID | Action and persisted result | Denial, race and retry checks |
| --- | --- | --- |
| `recovery/diagnosis` | Open the source task and exact run; compare cause, source action, original owner, recovery owner, attempt bounds and next action after reload. | Test an unrelated/private task and a stale run notice. Read-side retirement of a stale action must not create a new attempt, participant, or permission to replay. |
| `recovery/bounded-continuation` | Use a deterministic recoverable interruption and inspect the original run/session, attempt receipts, saved result and eventual useful output. | Repeat restart/receipt delivery, race Stop or a new owner, and retain unknown external outcomes. Accepted completion/finalization recovery must not start a new provider turn or repeat its side effect. |
| `recovery/source-action` | Inspect active and retained actions, follow the repair owner, and resolve one eligible source-bound action with its exact ID. | Retry the settled resolution and reject a stale/foreign action. Recovery ownership alone cannot mutate the source task; inspect source status, audit and wake independently. |
| `recovery/exhaustion` | Exhaust or age a bounded fixture; use the currently offered retry once, then inspect its durable acknowledgement and actual continuation. | Reassign, pause, stop, close, add an unresolved dependency, or impose a budget hold before retry. The old notice must not reopen terminal work or run the wrong owner. |
| `recovery/workspace` | Exercise retained-file recovery, export retry, reconstruction, branch repair/reconciliation and exact-owner finalization as distinct authorized operator paths. | Use exact source/action/run/receipt bindings and preserve existing files. Reject stale source, live/uncertain writers, unsafe archives and insufficient authority. Verify actual files and accepted result separately from queued acknowledgement. |
| `recovery/unknown-outcome` | Inspect the provider and saved intent before recording a source-specific chat, email or governed-provider outcome. | Use performed, not-performed and unresolved cases. Wrong company/request, stale state and unauthorized resolution must fail. Unknown effects must not replay automatically. An explicit retry must record the operator’s duplicate-risk acceptance and dispatch only the authorized attempt. |
| `recovery/user-continuation` | Save a distinguishable instruction while Stop cleanup is pending; after verified stop, inspect exactly one eligible continuation and its useful response. | Keep the message waiting under task/ancestor pause, budget or retained-file holds. Do not impersonate a human message or infer delivery from a queued wake. |
| `recovery/reconnect` | Disconnect the browser, let the server change persisted task/run state, reconnect, then reload and compare. | Inspect duplicate comments/decisions and private/company boundaries after access changes. Browser transport recovery and agent execution recovery require separate results. |

### `source-task`

Automated: [recovery actions](../../server/src/__tests__/issue-recovery-actions.test.ts)
covers source scoping, bounded attempts, operator stops, quota monitoring,
ownership, stale action retirement, and continuation deduplication.
[Recovery cards](../../ui/src/components/IssueRecoveryActionCard.test.tsx) cover
diagnosis, retry progress, exhaustion, and action availability. The fixture-backed
[execution-recovery journeys](../../tests/e2e/execution-recovery/recovery.spec.ts)
start their own test-drive instances and exercise safe, uncertain, restart,
manager-lineage, and legacy-unknown paths:

```sh
pnpm exec vitest run server/src/__tests__/issue-recovery-actions.test.ts ui/src/components/IssueRecoveryActionCard.test.tsx
pnpm exec playwright test -c tests/e2e/execution-recovery/playwright.config.ts recovery.spec.ts
```

Manual: open a stopped task through each affected navigation path. Confirm its
explanation, original owner, recovery owner if different, and next action. Follow
the supported recovery until the source task produces a useful result or a
specific escalation. Reload and verify that resolved notices retire and attempt
history remains. A fixture pass does not qualify every live harness/provider.

The [native restart integration suite](../../server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts)
also covers a prepared remote workspace interrupted before the executor's first
claim. Real database tests assert one same-run bootstrap claim under concurrent
controllers and reject prior claims, launch/provider evidence, and malformed
workspace references. These cases prove classification, not a live remote
provider restart. For that journey, interrupt a disposable deployment after
workspace preparation and before its first executor claim, then confirm one
provider turn starts on the original run through the normal admission gates.

Active remote process supervision distinguishes a failed health read from a
confirmed exit. The [executor tests](../../server/src/services/native-runtime/native-session-executor.test.ts)
exercise timeout recovery with a real listening process, unchanged ownership,
and rejected identity evidence. The Runner restart tests require positive exit
evidence before replacement. This coverage does not prove recovery of a
historical retained sandbox or behavior during a live provider outage.

For completion recovery, restart after a native completion proposal is appended
but before its session checkpoint. Verify that the original result is finalized
after provider termination, with no new provider turn or repeated external action.
The [runtime regressions](../../packages/paperclip-runner/src/native-session-runtime.test.ts)
exercise the real Codex driver with a simulated transport, including a still-active
provider and invalid, conflicting, duplicate, or stale proposals. This does not
qualify a hosted sandbox restart.

The same database suite pauses an original preparation while recovery claims
the remote run. It then verifies that the old preparation yields without opening
a provider or changing the recovery owner, for both live and expired leases.
[Heartbeat boundary tests](../../server/src/services/heartbeat/runtime-execution.test.ts)
verify that the detachment signal transfers recovery ownership before cleanup.
The suite also rejects an older unmarked preparation and verifies that calling
preparation again cannot add the fencing marker from supplied profile data.

For a native workspace owner hold, repeat issue reads and recovery checks after
the task becomes done or cancelled. Verify one unchanged action ID, attempt
count, and timestamps; task completion must not authorize copyback. Clear only
the exact receipt after operator stop verification, then confirm stale action
cleanup. The [route regressions](../../server/src/__tests__/issue-recovery-actions.test.ts)
and [heartbeat regression](../../server/src/__tests__/heartbeat-process-recovery.test.ts)
cover this sequence without a live operator recovery claim.

An intentionally Done onboarding parent can still need its validated
child-completion report. Recovery must not mark that callback successful before
execution solely because the parent is Done. The existing
[stale-lock sweep suite](../../server/src/__tests__/recovery-stale-issue-lock-sweep.test.ts)
covers delayed native/Legacy startup, invalid parent/child/company/assignee
bindings and a dead owner. Process-death and ownership backstops remain active.
Repeat the real onboarding journey and correlate callback turn events with its
reply and downloadable child file; status alone does not prove delivery. The
literal `ea6c8eb5e16d61111968f633a66748b397b64a3e` live failure is retained,
and the revised behavior still needs live qualification.

### `run-detail`

Automated: [run workspace recovery](../../ui/src/components/RunWorkspaceRecoverySurface.test.tsx)
tests this host; it is component coverage, not an end-to-end repair.

Manual: prepare a failed run with error code `workspace_validation_failed`, a
linked source task, and a live `workspace_validation` recovery action on that
task. Open that exact run and compare its recovery diagnosis to the source task.
Use an eligible action from the run surface, return to the task,
and verify the same action state, persisted outcome, and restored execution.
Repeat with an actor who lacks authority. Verify that the run-page controls are
absent for other error codes or after the source action retires; continue other
recovery checks on the source task. Full run-detail navigation remains a manual
gap.

### `operator-retry`

Automated: [disposition notices](../../ui/src/components/DispositionRecoveryNotice.test.tsx)
tests pending/error/gated states and waiting for the real retry acknowledgement.
The recovery-card suite covers workspace divergence, reissue, reconcile, and
confirmation. [Workspace export](../../ui/src/components/WorkspaceExportRecovery.test.tsx)
covers quiet restoration, legacy/operator assistance and resolved states.

For a retained legacy or native file hold, open the source task after its recovery
action has resolved but its files still need recovery. The shared task projection
shows actual working/backoff state or ordinary Retry. It does not show a separate
infrastructure attention card. Unknown external outcomes remain fenced internally.
An authorized board operator can use the resolution API to record verified files
and a backup link without changing task status or starting another run. The
server independently validates the original stopped-execution receipt. Agent
Chat retains the hold rather than suggesting another message. The
[notice](../../ui/src/components/ExecutionBlockerNotice.test.tsx) and
[repair route](../../server/src/__tests__/workspace-restore-repair-route.test.ts)
cover quiet live recovery, read-only access, stale or missing stop proof,
source-only repair, and preserved task status. These tests use fixtures; separately
verify original files and their attached artifact before recording a real repair.

For a source with a retained-file protection marker, exercise recovery through
the assembled environment runtime. Its exact preservation owner may reopen the
stopped allocation to read saved files; ordinary resume stays blocked. Reject a
changed claim, missing stop intent, wrong lease or wrong environment before a
provider call. Verify saved and newer local files, one preservation receipt, and
no additional agent turn. The PostgreSQL regression covers this boundary; the
opt-in provider probe also uses this runtime path with the protection marker.

For a missing managed allocation, verify a fresh Cloud-signed absence observation
under the exact physical recovery owner. The existing Retry may then select an
independent workspace through normal admission. Verify that the original run
stays failed and missing files are not called recovered. Refuse a foreign stack,
source, allocation or owner, expired signatures, changed provider organizations,
permission failures and provider outages. Local PostgreSQL and signed-protocol
regressions cover these boundaries; deployed recovery requires separate proof.

Repeat source-only repair with a `succeeded` legacy run that still has a retained
file obligation. Its result must remain successful, its current task owner and
status must stay unchanged, and later saved input must become eligible for normal
admission. A running or queued source and a normal retry of a successful turn
remain denied. The [reconciliation regressions](../../server/src/services/workspace-restore-reconciliation.test.ts)
cover these cases and stop-receipt validation without claiming live provider proof.

For an abandoned native copyback owner, the harness verifies the exact stopped
deployment and the reconciler restores saved work automatically. Task users see
no process details or shutdown form. The documented operator API handles older
receipts after independent platform verification, through a separate administrator
gate. The [authorization regressions](../../server/src/__tests__/authorization-service.test.ts)
and [route regressions](../../server/src/__tests__/issue-agent-mutation-ownership-routes.test.ts)
cover administrator admission, ordinary-member and agent denial, suspended and
foreign membership, missing role data, and stale cloud admin rows.
The [native workspace finalizer suite](../../server/src/services/native-runtime/native-workspace-finalizer.test.ts)
runs the real reconciler with a valid saved yield from `result_accepted`,
`workspace_finalizing`, and `retryable_failure`. It verifies physical fencing
before verified stop, automatic and operator recovery, successful export and commitment, hold resolution,
unchanged saved results, retained approval/monitor waits, and no new provider wake.
These local regressions do not prove a deployment platform stopped a foreign writer.

Manual: reproduce an exhausted disposable action. Click once, verify pending
state prevents repeated clicks, and inspect a successful continuation or an
explicit rejection. Reload to confirm the durable outcome. For a workspace
repair, record the compared branches/revisions and preserve uncommitted work;
confirm the repair's actual result before resuming. Check the denied and stale
action paths. A changed card label is insufficient proof of workspace integrity.

For graceful legacy shutdown, interrupt a disposable sandbox run while file
export is in flight. Delay settlement past the first 30-second wait. Confirm
the lease stays available, no repair hold or successor appears before export,
and the finalizer drain waits for the same owner. After export, confirm saved
files, successful lease cleanup, and one bounded continuation. Reload before
checking the successor. Repeat with controller loss: the expired fence must
retain the exact source and require repair, never claim restored files or start
a second executor. The database-backed
[shutdown regression](../../server/src/__tests__/heartbeat-process-recovery.test.ts)
checks finalizer joining, release order, durable retry uniqueness, and reload.
The [settlement regressions](../../server/src/services/heartbeat/recovery.test.ts)
cover other-controller fencing and owner loss. Provider boundaries are controlled
in these tests; they do not qualify a live sandbox export.

For an abandoned native controller, follow the [stop-verification procedure](../../doc/native-workspace-finalization-recovery.md)
with a disposable deployment. A new platform-bound owner recovers automatically
only after the harness signs proof that the exact deployment fully stopped.
Legacy owners require independently verified stop evidence through the operator
API; the task has no shutdown form. Confirm
the original accepted result commits, the recovery hold resolves, saved files
remain intact, and existing approval waits or monitor checks remain. No new agent
turn should start. Repeat with a retry-phase owner and an ordinary runtime manager;
the first can resume through automatic proof or authorized operator confirmation,
while the second cannot use the operator API.

### `post-stop-message`

Automated: [legacy continuation](../../server/src/services/recovery/legacy-continuation.test.ts),
[queue routes](../../server/src/__tests__/issue-queued-comments-routes.test.ts), and
[native restart recovery](../../server/src/services/native-runtime/native-restart-recovery.test.ts)
cover their respective recovery paths. [Legacy failure continuation](../../tests/e2e/legacy-failure-continuation.spec.ts)
adds a browser journey; it is not native runtime proof.

[Queued Stop database regressions](../../server/src/modules/wake-queue/adapters/queued-operator-stop-postgres.test.ts)
verify that an operator cancellation before runtime selection releases its own
locks, preserves deferred input without launching it, and leaves another active
cycle of the same routine unchanged. Provider cancellations and already selected
or dispatched runs retain their existing release behavior.

Manual: stop a disposable run, submit a distinguishable follow-up, and observe
any cleanup wait. After confirmed stop, verify the follow-up reaches one eligible
continuation and produces the requested answer. Repeat with a task/ancestor
pause and a budget hold: recovery must not bypass the gate. For unknown external
outcomes, inspect the provider before authorizing another operation.

### `browser-reconnect`

Automated: [live-update recovery](../../ui/src/context/LiveUpdatesProvider.recovery.test.tsx)
covers client transport recovery with mocks. It does not prove runner restart.

Manual: go offline during a disposable run, let the server reach a new state,
then reconnect. Confirm task/run/attention data refresh without duplicate
comments or decisions; reload and compare. A healthy websocket proves transport
only. Separately inspect the underlying execution if it is still stuck.

## Gotchas

- Legacy and native runtimes have different ownership and restart paths. Record
  which one was exercised instead of inferring coverage from the adapter name.
- A process disappearance, elapsed timeout, or successful API retry does not
  prove an external tool operation never happened. Unknown outcomes stay unknown
  until corroborated; automatic replay can duplicate a side effect.
- Active-run watchdogs, task watchdogs, reviewers, and recovery owners have
  different authority. No recovery card grants board permission by itself.
- Idle Agent Chat is not stranded work. An intentional operator stop must not
  silently trigger recovery that fights the user's instruction.
- Source inspection and mocked component tests do not qualify real server
  restart continuity. Use the appropriate runtime suite for that claim.
- See [execution semantics](../../doc/execution-semantics.md) for the governing
  recovery contract and [steering](./steering.md) for saved follow-ups.

### Storybook verification

#### `exhaustion`

Capability ID: `recovery/exhaustion`.

Scope: ui
Storybook: Exhausted/overdue attempts, operator retry pending/error, blocked authority/gate and specific escalation.
Production: Inspect durable attempt bounds and actual eligible retry/repair; acknowledgment alone does not prove continued execution.
Sources: Source: [IssueRecoveryActionCard.tsx](../../ui/src/components/IssueRecoveryActionCard.tsx), [DispositionRecoveryNotice.tsx](../../ui/src/components/DispositionRecoveryNotice.tsx), [issue-recovery-actions.ts](../../server/src/services/issue-recovery-actions.ts). Tests: [IssueRecoveryActionCard.test.tsx](../../ui/src/components/IssueRecoveryActionCard.test.tsx), [DispositionRecoveryNotice.test.tsx](../../ui/src/components/DispositionRecoveryNotice.test.tsx), [issue-recovery-actions.test.ts](../../server/src/__tests__/issue-recovery-actions.test.ts), [recovery.spec.ts](../../tests/e2e/execution-recovery/recovery.spec.ts)

#### `unknown-outcome`

Capability ID: `recovery/unknown-outcome`.

Scope: ui
Storybook: Uncertain external outcome, required inspection/evidence and explicit permitted operator decision.
Production: Corroborate provider outcome before authorization; enforce no automatic external side-effect replay and reject stale/unauthorized decisions.
Sources: Source: [IssueRecoveryActionCard.tsx](../../ui/src/components/IssueRecoveryActionCard.tsx), [issue-recovery-actions.ts](../../server/src/services/issue-recovery-actions.ts). Tests: [IssueRecoveryActionCard.test.tsx](../../ui/src/components/IssueRecoveryActionCard.test.tsx), [issue-recovery-actions.test.ts](../../server/src/__tests__/issue-recovery-actions.test.ts), [recovery.spec.ts](../../tests/e2e/execution-recovery/recovery.spec.ts)

#### `user-continuation`

Capability ID: `recovery/user-continuation`.

Scope: ui
Storybook: Saved follow-up waiting on stop cleanup, pause/budget gate, one eligible continuation and result/failure.
Production: Confirm previous execution stopped before delivery, preserve message, avoid duplicate wakes and honor actual task/ancestor/budget gate in separate legacy/native paths.
Sources: Source: [TaskChatQueuedMessages.tsx](../../ui/src/components/task-chat/TaskChatQueuedMessages.tsx), [legacy-continuation.ts](../../server/src/services/recovery/legacy-continuation.ts), [native-restart-recovery.ts](../../server/src/services/native-runtime/native-restart-recovery.ts). Tests: [legacy-continuation.test.ts](../../server/src/services/recovery/legacy-continuation.test.ts), [native-restart-recovery.test.ts](../../server/src/services/native-runtime/native-restart-recovery.test.ts), [issue-queued-comments-routes.test.ts](../../server/src/__tests__/issue-queued-comments-routes.test.ts), [legacy-failure-continuation.spec.ts](../../tests/e2e/legacy-failure-continuation.spec.ts)
