---
navigation: {"section":"Tasks and conversations","sectionOrder":20,"order":60}
---

# Steering and queued messages

People can send follow-ups while an agent works, manage saved messages that have
not been consumed, and choose when to steer or interrupt. Stopping a run and
pausing a task are separate controls. The UI must preserve the message, explain
why it is waiting, and only claim delivery after an authoritative acknowledgement.

Feature ID: `steering`.

Agent access: [companion](../agent-access-map/steering.md).

## Sub-features

- `queue`: `steering/queue` — a busy task saves follow-ups and shows their order and wait reason.
- `edit-order-discard`: `steering/edit-order-discard` — edit full Markdown, reorder, and discard eligible saved
  messages; ownership, revision conflicts, and already-dispatched states matter.
- `steer`: `steering/steer` — explicit user action sends a queued message into a compatible active
  run; unavailable capabilities and provider rejection remain visible.
- `interrupt`: `steering/interrupt` — stop the current execution and carry accepted follow-ups into
  the eligible continuation without delivering them twice.
- `stop-and-pause`: `steering/stop-and-pause` — distinguish stop-in-flight, confirmed stop, task/ancestor
  pause, agent pause, and budget hold. Resume must respect the actual gate.
- `drafts`: `steering/drafts` — switching tasks, reloading, and uncertain submission retain the
  correct task's draft and attachment receipts.
- `approval-queue`: `steering/approval-queue` — answered questions and accepted approvals have durable
  delivery distinct from editable ordinary comments.

## How to get to it (user POV)

### `task-composer`

Open an assigned task (`/issues/:issueId`). Start work, then send follow-ups while
the agent runs. Use the queued-message controls to edit, reorder, discard,
steer, or interrupt when offered. After Stop, choose **Send** on a saved queue to explicitly continue it without recreating the messages or attachments. Native steering still requires an active turn; Send after Stop is a separate user decision. Use the composer stop/pause control separately.
Both task presentations need attention when changing their shared behavior.

### `agent-chat`

Enable Agent Chat and open an agent conversation. Send another message during
a reply and inspect the shared queue. `/new` starts fresh provider context in
the same conversation; it is an ordered boundary, not a normal model prompt.

### `request-response`

Answer an earlier question or accept a confirmation while successor work is
active on the task. Inspect the resulting queued response and its available
steer/interrupt control instead of assuming acceptance interrupted execution.

### `external-channel`

Send a follow-up from a linked external chat conversation while its task is
running. Use that provider's supported stop/control affordance where available;
inspect the resulting task and run in Paperclip.

## Driving it

The explicit `stop-redirect` [Product journey](../../tests/runner-e2e/PRODUCT-JOURNEYS.md) covers `steering/stop-and-pause` only for Stop and one new direction. It requires active work, native cancellation acknowledgement, resource cleanup, and completion without later original-turn activity. It does not qualify pause, interrupt, or all queued-message behavior. Source registration is not a live Cloud pass.

Preconditions: follow the [baseline](./README.md#before-driving-a-journey).
Use an agent that stays busy long enough to inspect the queue. Record the adapter,
native/legacy mode, and advertised steering capability. Test supported and
unsupported steering without treating an absent capability as a product failure.

### `task-composer`

Automated: [queued-message UI](../../ui/src/components/task-chat/TaskChatQueuedMessages.test.tsx)
covers order, failure restoration, unavailable steering, stale revisions, and
discard acknowledgements. [Queue routes](../../server/src/__tests__/issue-queued-comments-routes.test.ts)
cover durable ordering, authorization, steering acknowledgements, interrupt
recovery, and concurrent dispatch. [Composer](../../ui/src/components/task-chat/TaskChatComposer.test.tsx)
covers drafts and uncertain saves.

[Task-detail delivery races](../../ui/src/pages/IssueDetail.test.tsx) cover a
consumed message whose send response and queue snapshot arrive late. A started
run's input receipt removes that message from pending, while a separate unsent
message stays queued. Admission to a run that has not started is not delivery.
A later retry of the same message remains visible in its new authoritative queue.
A queued turn's own starting input stays in history before execution, including
board messages that reopen a task. Later inputs keep their queue controls and
full canonical order. A maintenance hold displays its current admission wait;
drain release and expiry prompt normal admission without a manual retry.
Receipts retain the primary wake and coalesced source queue IDs. They clear a late
snapshot even when its target names the preceding run or is null.

```sh
pnpm exec vitest run ui/src/components/task-chat/TaskChatQueuedMessages.test.tsx server/src/__tests__/issue-queued-comments-routes.test.ts
```

Automated stop coverage is separate:
[composer stop](../../tests/e2e/composer-stop.spec.ts) with
[its configuration](../../tests/e2e/playwright-composer-stop.config.ts) and
[ACP stop/continuation](../../tests/e2e/acp-stop-continuation.spec.ts). Inspect their
fixture and opt-in prerequisites; skipped native cases are not native proof.
The explicit [follow-up/Stop/resume journey](../../tests/runner-e2e/followup-stop-resume-flow.ts)
requires a later user message before continuation. The
[database Stop accounting regression](../../server/src/services/native-runtime/native-stop-accounting.integration.test.ts)
checks complete and late receipts without another provider turn. These are
separate scopes; database success does not establish deployed or Slack acceptance.

Manual: queue three distinguishable messages. Edit one, reorder them, reload,
and confirm the saved order. Discard one and confirm it never reaches execution.
After a queued message enters a started run, confirm it leaves pending even if
the send response arrives later. Reload and confirm it appears once in history.
Steer one while busy and verify the agent receives that exact message once.
Repeat with a rejected steer and a stale second-tab edit; the UI must preserve
retryable content and explain the conflict. On a fresh run, interrupt with a
queued follow-up and verify confirmed stop followed by one continuation. Pause
the task (and separately its ancestor), preserve a draft, then resume the actual
hold; no hidden send should occur while paused. Check both task presentations
when available; the named component tests do not prove every host integration.

Fixture-backed recovery check: start with an agent in its completed paused
lifecycle state, then insert a new accepted `deferred_issue_execution` request
through the [PostgreSQL recovery fixture](../../server/src/modules/wake-queue/adapters/postgres.test.ts).
Normal wake admission
rejects paused agents, so this pending state cannot be created by sending a new
message through the ordinary UI or API. Let release and periodic recovery run.
Confirm that the saved request remains pending. Resume the agent, wait for its
lifecycle to become ready, and verify one delivery. An explicit Pause cancels
older queued work; those cancelled receipts must not be replayed. A paused
request must not prevent another eligible recipient's queued work from proceeding.

### `agent-chat`

Automated: [agent chat sessions](../../tests/e2e/agent-chat-sessions.spec.ts) covers
persistent conversation/session behavior with deterministic harness fixtures;
shared composer tests cover the controls. These do not qualify live steering
for every harness.

Manual: queue two follow-ups while the conversation replies. Reload, edit or
discard one, then let the other run. Verify one reply and unchanged conversation
identity. Send `/new`, then a new prompt; old history remains visible, and the
new turn uses fresh provider context. Verify a useful answer rather than only
the session-divider UI. Repeat the queue operations with a live capable harness
when the change touches delivery.

### `request-response`

Automated: [response delivery](../../server/src/__tests__/question-response-delivery.test.ts)
proves queueing/coalescing and retry-safe receipts. The queue-route suite tests
separate comment and approval queues, explicit steering, and fresh-session
restrictions on plan approvals.

Manual: answer an old question during a new run, confirm that it is saved and
queued, and let the active run end. Verify exactly one continuation with the
answer. Repeat an eligible approval with explicit steer; another approval that
requires a fresh session must not offer same-turn delivery. Do not edit an
approval outcome through an ordinary queued-message editor.

### `external-channel`

Automated: [chat interaction arbitration](../../server/src/services/chat-interaction-arbitration.test.ts)
covers backend arbitration with simulated requests. It is not a provider UI test.

Manual: send two distinguishable messages through one disposable linked
conversation while busy. Inspect their saved task order, run delivery, and
external reply. Check a duplicate provider event and unauthorized sender.
Provider-specific control semantics and real transport timing remain a manual
gap; do not assume browser queue controls are available in every channel.

## Gotchas

- Paperclip's queue is server-owned once saved; it is not Omnigent's unsent
  browser draft buffer. A stale edit must not overwrite a consumed message.
- Steer availability depends on the active runtime's capability, not its brand
  name. A UI row disappearing optimistically does not prove provider receipt.
- Interrupt, stop, task pause, agent pause, and budget pause have different
  effects. A running indicator disappearing does not prove remote work stopped.
- An interrupted run may need verified cleanup before a saved follow-up can
  start. Preserve and inspect the wait reason; see [recovery](./recovery.md).
- A healthy idle Agent Chat is waiting for input, not stranded unfinished work.

### Storybook verification

#### `drafts`

Capability ID: `steering/drafts`.

Scope: ui
Storybook: Task-keyed restored draft and attachment receipts; task switch/reload, failed send and uncertain-save recovery.
Production: Retain correct task draft across navigation and reload; inspect authoritative saved receipt before claiming delivery; do not clear storage on every harness mount.
Sources: Source: [TaskChatComposer.tsx](../../ui/src/components/task-chat/TaskChatComposer.tsx), [composer-draft.ts](../../ui/src/lib/composer-draft.ts). Tests: [TaskChatComposer.test.tsx](../../ui/src/components/task-chat/TaskChatComposer.test.tsx), [issue-queued-comments-routes.test.ts](../../server/src/__tests__/issue-queued-comments-routes.test.ts)

#### `approval-queue`

Capability ID: `steering/approval-queue`.

Scope: ui
Storybook: Answered question/accepted approval delivery waiting, eligible steer/interrupt, failed delivery and fresh-session-only approval.
Production: Keep response delivery durable and distinct from editable comments; coalesce once, enforce fresh-session restrictions and deduplicate concurrent/retried continuation.
Sources: Source: [TaskChatQueuedMessages.tsx](../../ui/src/components/task-chat/TaskChatQueuedMessages.tsx), [question-response-delivery.ts](../../server/src/services/question-response-delivery.ts). Tests: [TaskChatQueuedMessages.test.tsx](../../ui/src/components/task-chat/TaskChatQueuedMessages.test.tsx), [question-response-delivery.test.ts](../../server/src/__tests__/question-response-delivery.test.ts), [issue-queued-comments-routes.test.ts](../../server/src/__tests__/issue-queued-comments-routes.test.ts)
