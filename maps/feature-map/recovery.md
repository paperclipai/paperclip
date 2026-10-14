---
navigation: {"section":"Projects and execution","sectionOrder":40,"order":50}
---

# Recovery

People can see why a task stopped, who owns the next action, and whether a safe
continuation is available. Recovery retains task context and ownership, honors
pause and budget gates, and distinguishes confirmed failure from an uncertain
external outcome. A retry acknowledgement alone is not proof that work resumed.

Agent access: [companion](../agent-access-map/recovery.md).

## Sub-features

- `diagnosis`: a task/run exposes the recorded cause, evidence, owner, attempt
  progress, and next action without requiring a raw-log interpretation.
- `bounded-continuation`: supported interrupted work continues with preserved
  conversation context and bounded attempts, without blindly replaying tools.
- `source-action`: source-scoped recovery actions remain attached to the task;
  independent repair work may have its own issue and return owner.
- `exhaustion`: exhausted or overdue recovery exposes the current gate and
  permitted operator action; it does not claim an automatic path is still live.
- `workspace`: workspace divergence/export failures show the applicable repair,
  reconcile, or isolated reissue action with evidence and authority checks.
- `unknown-outcome`: uncertain external side effects require inspection and
  an explicit decision, not automatic replay.
- `user-continuation`: saved user messages after a stop are reconsidered once
  cleanup proves the old execution is stopped; duplicate wakes are avoided.
- `reconnect`: browser stream recovery refreshes persisted state without claiming
  the agent itself restarted or that a failed run succeeded.

## How to get to it (user POV)

### `source-task`

Open the affected task from Tasks, Inbox/Blocked, search, or a direct task link.
Inspect the recovery notice/card in its history, expand details if needed, and
use the currently offered action. Follow any linked repair task and return owner.

### `run-detail`

Open the agent's run (`/agents/:agentId/runs/:runId`) from activity or the task's
run link. The run page hosts workspace recovery controls only for a failed run
with error code `workspace_validation_failed` and a linked source task that still
has a live `workspace_validation` recovery action. Use the source task for other
stopped-run recovery checks.

### `operator-retry`

On an exhausted disposition or workspace recovery card, inspect the current
reason and use the permitted retry/repair/reconcile action. Some repairs require
confirmation; unavailable actions must explain the gate or remain absent.

### `post-stop-message`

After a stop, send a new instruction on the same task or inspect one already
saved while cleanup was pending. Observe the waiting message, continuation, and
eventual result rather than manually changing the task status to look complete.

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

For a native workspace owner hold, repeat issue reads and recovery checks after
the task becomes done or cancelled. Verify one unchanged action ID, attempt
count, and timestamps; task completion must not authorize copyback. Clear only
the exact receipt after operator stop verification, then confirm stale action
cleanup. The [route regressions](../../server/src/__tests__/issue-recovery-actions.test.ts)
and [heartbeat regression](../../server/src/__tests__/heartbeat-process-recovery.test.ts)
cover this sequence without a live operator recovery claim.

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

For a retained legacy file hold, open the source task after its recovery action
has resolved but its files still need recovery. An authorized board operator can
record the verified recovered files and backup link without changing the current
task status or starting another run. The server must independently validate the
original stopped-execution receipt. Agent Chat must show the file hold rather than
suggesting another message. The [file recovery form](../../ui/src/components/WorkspaceFileRecovery.test.tsx),
[notice](../../ui/src/components/ExecutionBlockerNotice.test.tsx), and
[repair route](../../server/src/__tests__/workspace-restore-repair-route.test.ts)
cover evidence/confirmation, read-only access, stale or missing stop proof,
source-only repair, and preserved task status. These tests use fixtures; separately
verify original files and their attached artifact before recording a real repair.

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

Scope: ui
Storybook: Exhausted/overdue attempts, operator retry pending/error, blocked authority/gate and specific escalation.
Production: Inspect durable attempt bounds and actual eligible retry/repair; acknowledgment alone does not prove continued execution.
Sources: Source: [IssueRecoveryActionCard.tsx](../../ui/src/components/IssueRecoveryActionCard.tsx), [DispositionRecoveryNotice.tsx](../../ui/src/components/DispositionRecoveryNotice.tsx), [issue-recovery-actions.ts](../../server/src/services/issue-recovery-actions.ts). Tests: [IssueRecoveryActionCard.test.tsx](../../ui/src/components/IssueRecoveryActionCard.test.tsx), [DispositionRecoveryNotice.test.tsx](../../ui/src/components/DispositionRecoveryNotice.test.tsx), [issue-recovery-actions.test.ts](../../server/src/__tests__/issue-recovery-actions.test.ts), [recovery.spec.ts](../../tests/e2e/execution-recovery/recovery.spec.ts)

#### `unknown-outcome`

Scope: ui
Storybook: Uncertain external outcome, required inspection/evidence and explicit permitted operator decision.
Production: Corroborate provider outcome before authorization; enforce no automatic external side-effect replay and reject stale/unauthorized decisions.
Sources: Source: [IssueRecoveryActionCard.tsx](../../ui/src/components/IssueRecoveryActionCard.tsx), [issue-recovery-actions.ts](../../server/src/services/issue-recovery-actions.ts). Tests: [IssueRecoveryActionCard.test.tsx](../../ui/src/components/IssueRecoveryActionCard.test.tsx), [issue-recovery-actions.test.ts](../../server/src/__tests__/issue-recovery-actions.test.ts), [recovery.spec.ts](../../tests/e2e/execution-recovery/recovery.spec.ts)

#### `user-continuation`

Scope: ui
Storybook: Saved follow-up waiting on stop cleanup, pause/budget gate, one eligible continuation and result/failure.
Production: Confirm previous execution stopped before delivery, preserve message, avoid duplicate wakes and honor actual task/ancestor/budget gate in separate legacy/native paths.
Sources: Source: [TaskChatQueuedMessages.tsx](../../ui/src/components/task-chat/TaskChatQueuedMessages.tsx), [legacy-continuation.ts](../../server/src/services/recovery/legacy-continuation.ts), [native-restart-recovery.ts](../../server/src/services/native-runtime/native-restart-recovery.ts). Tests: [legacy-continuation.test.ts](../../server/src/services/recovery/legacy-continuation.test.ts), [native-restart-recovery.test.ts](../../server/src/services/native-runtime/native-restart-recovery.test.ts), [issue-queued-comments-routes.test.ts](../../server/src/__tests__/issue-queued-comments-routes.test.ts), [legacy-failure-continuation.spec.ts](../../tests/e2e/legacy-failure-continuation.spec.ts)
