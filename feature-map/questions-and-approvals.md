# Questions and approvals

People answer an agent's questions and decide requests without losing the task's
history. A question, plan confirmation, governance approval, and app-tool review
can look similar but have different authority and continuation rules. Each
decision must stay attached to its original request and survive reload.

## Sub-features

- `questions`: single-choice, multiple-choice, custom, and free-text answers;
  paged forms retain answers until submission and show validation failures.
- `dismiss-and-reopen`: unanswered questions remain in the feed after dismissal
  or a newer message; reopening restores the form without inventing an answer.
- `confirmations`: accept, decline, or request changes; stale, expired, resolved,
  and withdrawn requests cannot be acted on again.
- `plan-review`: inspect the requested plan revision before accepting or asking
  for changes. An ordinary planning task can proceed to execution; Agent Chat
  hands work to linked tasks and remains a conversation.
- `audience`: the current actor, company, named audience, and review policy govern
  resolution. A visible request is not necessarily actionable by that viewer.
- `governance`: pending/history views, approve/reject, revision request, and
  resubmission for formal board approvals.
- `tool-review`: approve once, always allow the displayed scope, or decline;
  decision status and provider execution outcome remain distinct.
- `continuation`: one recorded response leads to the eligible waiting run or
  continuation; repeated clicks, reloads, and competing tabs do not repeat work.

## How to get to it (user POV)

### `task-thread`

Open a task from Tasks, search, a project, or its direct `/issues/:issueId` link.
Answer the question near the composer, or reopen its compact unanswered entry
in the history. Open the plan preview before using the confirmation controls.
Exercise both available task presentations when a change affects shared cards.

### `agent-chat`

With Agent Chat enabled, choose Chat and an agent (`/chats/:agentRef`). Answer,
dismiss, or reopen requests in this persistent conversation. A plan handoff here
creates linked work rather than turning the conversation into implementation.

### `attention`

Open Decisions (`/decisions`, including a saved queue) or an Inbox attention row.
Expand an actionable interaction inline; follow its task link to inspect context.
With combined Inbox/Tasks enabled, open the corresponding Tasks view instead.

### `board-approval`

Open Approvals → Pending or All (`/approvals/pending`, `/approvals/all`). Use the
card action or open `/approvals/:approvalId` for details, comments, revision
request, and resubmission. These are formal approvals, not ordinary questions.

### `app-review`

In a task, open **Review request** for an Ask first app call. The same request
appears in Apps → Review (`/apps/review`) and the connection's Review tab.
Use **Approve & run**, **Always allow**, or **Decline** on the surface under test.

### `skill-test`

Open Skill Studio, run a skill test that produces an interaction, and inspect
its output card. Skill-test authority is narrower than an ordinary company run.

### `external-channel`

In a configured chat channel, answer a published question or confirmation as a
linked sender. Open the associated Paperclip task to inspect the saved outcome.
Channel-specific forms and identity linking require separate provider evidence.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey).
Use separate disposable requests for accept, decline, and revision paths. Record
the actor and request revision. Prepare a waiting question through a test agent;
a component fixture alone cannot prove live response delivery.

### `task-thread`

Automated: [interaction cards](../ui/src/components/IssueThreadInteractionCard.test.tsx),
[paged task cards](../ui/src/components/task-chat/TaskChatInteractionCard.test.tsx),
and [task thread](../ui/src/components/TaskChatThread.test.tsx) cover form,
receipt, and dismissal behavior. [Resolution routes](../server/src/__tests__/issue-thread-interaction-routes.test.ts)
and [response delivery](../server/src/__tests__/question-response-delivery.test.ts)
cover authority and durable continuation. Run a targeted set with:

```sh
pnpm exec vitest run ui/src/components/TaskChatThread.test.tsx server/src/__tests__/question-response-delivery.test.ts
```

Manual: answer a multi-page question, go back, edit, then submit. Reload and
confirm the saved answers and one agent continuation. On a fresh request,
dismiss, reload, reopen, and verify the draft. Send a new comment while a
question remains unanswered; it must stay reopenable in history. Try a denied
actor and a request already resolved in another tab; expect an explicit error
or settled receipt, never a second decision. For plans, change the plan revision
before trying the old approval, then review the current revision.

### `agent-chat`

Automated: the [task thread suite](../ui/src/components/TaskChatThread.test.tsx)
parameterizes unanswered-question history for conversation mode on and off.
This proves component parity, not a model's plan handoff.

Manual: repeat dismissal, reload, reopening, and answer submission in Chat.
Approve a plan and inspect the linked execution task and copied plan. The chat
history remains and the conversation does not close as a completed task.

### `attention`

Automated: [attention resolver](../ui/src/components/AttentionInteractionResolver.test.tsx)
covers preparing-request refresh without accepting it. The resolution-route
tests above cover the API, not every Decisions or Inbox navigation path.

Manual: open the same pending request in an attention row and task tab. Resolve
from the row; both surfaces must settle after refresh. Check an empty queue,
loading, permission denial, and a stale request. Repeat with combined Inbox/Tasks
on when that surface is part of the change. Full navigation parity remains a
manual coverage gap.

### `board-approval`

Automated: [approval service](../server/src/__tests__/approvals-service.test.ts)
and [idempotency routes](../server/src/__tests__/approval-routes-idempotency.test.ts)
cover persistence and duplicate decisions. They do not drive the approval pages.

Manual: create disposable formal approval requests; approve one from the list,
reject another from details, and request revision on a third. Resubmit that
third request and verify Pending/All and detail history after reload. Confirm
the recorded decision and its governed effect, not just a success toast.

### `app-review`

Automated: [connection reviews](../tests/e2e/connection-reviews.spec.ts) drives
task/queue synchronization, approve, decline, remembered permission, provider
failure, and restart with a scripted process agent and local MCP provider:

```sh
pnpm exec playwright test -c tests/e2e/connection-reviews.config.ts
```

Manual: dismiss and reopen a review, decide it from each entry point using fresh
requests, and inspect the continuation's useful result. Always allow must show
its scope; a future action with changed arguments should obey the saved rule.
Provider failure must remain an approved decision with a failed execution.
Real provider and model checks follow [Task reviews](../doc/connections/TASK-REVIEWS.md#verification-workflows).

### `skill-test`

Automated: [read-only interaction contract](../server/src/__tests__/issue-interactions-read-only-contract.test.ts)
checks that fetching interactions does not mutate them. Shared card suites cover
rendering. Neither proves the complete Skill Studio host or its permission matrix.

Manual: run a skill test with a question, answer through its visible output,
and inspect the test result. Attempt a governed action outside the test's scope;
expect denial. The complete Skill Studio browser journey is not covered by the
referenced unit tests.

### `external-channel`

Automated: [chat question forms](../server/src/services/chat-question-forms.test.ts),
[Discord forms](../server/src/services/chat-discord-question-forms.test.ts),
and [interaction publications](../server/src/__tests__/chat-interaction-publications.test.ts)
cover serialization and delivery logic with fixtures.

Manual: use a disposable provider conversation, answer as the linked sender,
and check the task's persisted result and one continuation. Repeat from an
unlinked or wrong sender and with an expired card. A browser answer does not
qualify Slack, Discord, Telegram, email, or iMessage; record each as not run
unless its actual provider journey was driven.

## Gotchas

- Dismissing a question does not answer it. Dismissing an app review neither
  grants permission nor resumes the agent. Ordinary comments cannot approve it.
- A resolved request and a successful tool execution are separate facts.
- Do not reuse an accepted request to test rejection; use another request.
- Agent Chat and skill tests have distinct lifecycle/authority rules despite
  sharing UI. A watchdog cannot acquire board authority by resolving a card.
- An answer to an old question can queue behind a successor run; it does not
  automatically steer that run. See [steering](./steering.md).
