# Steering and queued messages

People can send follow-ups while an agent works, manage saved messages that have
not been consumed, and choose when to steer or interrupt. Stopping a run and
pausing a task are separate controls. The UI must preserve the message, explain
why it is waiting, and only claim delivery after an authoritative acknowledgement.

## Sub-features

- `queue`: a busy task saves follow-ups and shows their order and wait reason.
- `edit-order-discard`: edit full Markdown, reorder, and discard eligible saved
  messages; ownership, revision conflicts, and already-dispatched states matter.
- `steer`: explicit user action sends a queued message into a compatible active
  run; unavailable capabilities and provider rejection remain visible.
- `interrupt`: stop the current execution and carry accepted follow-ups into
  the eligible continuation without delivering them twice.
- `stop-and-pause`: distinguish stop-in-flight, confirmed stop, task/ancestor
  pause, agent pause, and budget hold. Resume must respect the actual gate.
- `drafts`: switching tasks, reloading, and uncertain submission retain the
  correct task's draft and attachment receipts.
- `approval-queue`: answered questions and accepted approvals have durable
  delivery distinct from editable ordinary comments.

## How to get to it (user POV)

### `task-composer`

Open an assigned task (`/issues/:issueId`). Start work, then send follow-ups while
the agent runs. Use the queued-message controls to edit, reorder, discard,
steer, or interrupt when offered. Use the composer stop/pause control separately.
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

Preconditions: follow the [baseline](./README.md#before-driving-a-journey).
Use an agent that stays busy long enough to inspect the queue. Record the adapter,
native/legacy mode, and advertised steering capability. Test supported and
unsupported steering without treating an absent capability as a product failure.

### `task-composer`

Automated: [queued-message UI](../ui/src/components/task-chat/TaskChatQueuedMessages.test.tsx)
covers order, failure restoration, unavailable steering, stale revisions, and
discard acknowledgements. [Queue routes](../server/src/__tests__/issue-queued-comments-routes.test.ts)
cover durable ordering, authorization, steering acknowledgements, interrupt
recovery, and concurrent dispatch. [Composer](../ui/src/components/task-chat/TaskChatComposer.test.tsx)
covers drafts and uncertain saves.

```sh
pnpm exec vitest run ui/src/components/task-chat/TaskChatQueuedMessages.test.tsx server/src/__tests__/issue-queued-comments-routes.test.ts
```

Automated stop coverage is separate:
[composer stop](../tests/e2e/composer-stop.spec.ts) with
[its configuration](../tests/e2e/playwright-composer-stop.config.ts) and
[ACP stop/continuation](../tests/e2e/acp-stop-continuation.spec.ts). Inspect their
fixture and opt-in prerequisites; skipped native cases are not native proof.

Manual: queue three distinguishable messages. Edit one, reorder them, reload,
and confirm the saved order. Discard one and confirm it never reaches execution.
Steer one while busy and verify the agent receives that exact message once.
Repeat with a rejected steer and a stale second-tab edit; the UI must preserve
retryable content and explain the conflict. On a fresh run, interrupt with a
queued follow-up and verify confirmed stop followed by one continuation. Pause
the task (and separately its ancestor), preserve a draft, then resume the actual
hold; no hidden send should occur while paused. Check both task presentations
when available; the named component tests do not prove every host integration.

### `agent-chat`

Automated: [agent chat sessions](../tests/e2e/agent-chat-sessions.spec.ts) covers
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

Automated: [response delivery](../server/src/__tests__/question-response-delivery.test.ts)
proves queueing/coalescing and retry-safe receipts. The queue-route suite tests
separate comment and approval queues, explicit steering, and fresh-session
restrictions on plan approvals.

Manual: answer an old question during a new run, confirm that it is saved and
queued, and let the active run end. Verify exactly one continuation with the
answer. Repeat an eligible approval with explicit steer; another approval that
requires a fresh session must not offer same-turn delivery. Do not edit an
approval outcome through an ordinary queued-message editor.

### `external-channel`

Automated: [chat interaction arbitration](../server/src/services/chat-interaction-arbitration.test.ts)
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
