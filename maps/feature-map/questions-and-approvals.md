---
navigation: {"section":"Tasks and conversations","sectionOrder":20,"order":50}
---

# Questions and approvals

People answer an agent's questions and decide requests without losing the task's
history. A question, plan confirmation, governance approval, and app-tool review
can look similar but have different authority and continuation rules. Each
decision must stay attached to its original request and survive reload.

Feature ID: `questions-and-approvals`.

Agent access: [companion](../agent-access-map/questions-and-approvals.md).

## Sub-features

- `questions`: `questions-and-approvals/questions` — single-choice, multiple-choice, custom, and free-text answers;
  paged forms retain answers until submission and show validation failures.
- `dismiss-and-reopen`: `questions-and-approvals/dismiss-and-reopen` — questions and composer requests (including completion reviews) remain in the feed after dismissal
  or a newer message; reopening restores the form without inventing an answer.
- `confirmations`: `questions-and-approvals/confirmations` — accept, decline, or request changes; stale, expired, resolved,
  and withdrawn requests cannot be acted on again.
- `plan-review`: `questions-and-approvals/plan-review` — inspect the requested plan revision before accepting or asking
  for changes. An ordinary planning task can proceed to execution; Agent Chat
  hands work to linked tasks and remains a conversation.
- `audience`: `questions-and-approvals/audience` — the current actor, company, named audience, and review policy govern
  resolution. A visible request is not necessarily actionable by that viewer.
- `governance`: `questions-and-approvals/governance` — pending/history views, approve/reject, revision request, and
  resubmission for formal board approvals.
- `tool-review`: `questions-and-approvals/tool-review` — approve once, always allow the displayed scope, or decline;
  decision status and provider execution outcome remain distinct.
- `continuation`: `questions-and-approvals/continuation` — one recorded response leads to the eligible waiting run or
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

**Operation checkpoints**

Use these checks alongside the entry-point recipes below and the operation records in the [access companion](../agent-access-map/questions-and-approvals.md). Record the actual actor, surface, saved result and denial separately. Source review and linked tests do not establish a live pass.

| Capability ID | Action and persisted result | Denial, race and retry checks |
| --- | --- | --- |
| `questions-and-approvals/questions` | Create fixed-ID single/multiple/custom/text questions; move between pages, submit, and reload the saved answer and responder. | Reject missing/invalid answers without resolving. Competing answers settle once. Distinguish cancel, withdraw, historical Done-task answers, and local dismissal; historical answers must not restart work. |
| `questions-and-approvals/dismiss-and-reopen` | Dismiss questions, completion reviews, confirmations, choices, and item requests without deciding; reload and reopen from history. | Confirm the server request remains pending and a new ordinary comment does not answer it. Resolve in another tab and refresh the old form. Saved-request dismissals persist on the server and suppress repeated agent demands; drafts and raw runtime dismissals remain browser-local. Protected actions still require authorization. |
| `questions-and-approvals/confirmations` | Use separate accept, decline/change-request, checkbox subset, suggested-task selection, and partial item-verdict requests. Inspect the actual selected items and created task IDs. | Test invalid selections, child-without-parent selection, expiry, supersession, withdrawal, and repeated/conflicting decisions. Partial verdicts persist; skip must not start a continuation. |
| `questions-and-approvals/plan-review` | Open the exact requested plan revision; reject one request and accept another. Inspect saved revision, work mode, owner, and the resulting continuation. | Edit after requesting review and reject stale acceptance. Test finalization readiness and bound completion review separately. In Agent Chat, inspect the later project/task creation and its source-plan provenance; acceptance alone is not a completed handoff. |
| `questions-and-approvals/audience` | Repeat a request for a named person, named agent, human-only resolver, and independent reviewer. Inspect actionability and final attribution. | Test creator exclusion, wrong audience/company, private task, missing or cancelled run, and changed responsible-user access. A human comment used by an agent remains subject to that agent’s resolver authority. |
| `questions-and-approvals/governance` | Create and inspect a formal request, comment, request revision, resubmit, then approve or reject distinct requests. Reload history and linked task state. | Test board decision authority separately from agent request/comment/resubmit authority. A repeated decision cannot repeat activation. Current pending status, payload revision, and governed side effects must agree. |
| `questions-and-approvals/tool-review` | Invoke a harmless Ask first action, compare task and Apps review surfaces, then exercise Approve once, Always allow, and Decline separately. | No provider call before approval. Repeat decisions and compare invocation count. Change the tool definition, revoke access, or set Off before a decision. Record the approval decision and provider outcome independently. |
| `questions-and-approvals/continuation` | After answering, inspect the saved response, delivery receipt, eligible run, and useful result in the original task/thread. | Reload, race two tabs, and interrupt delivery after saving. Require one continuation without repeated external actions. Reassignment, Stop, pause, budget, and external-thread boundaries remain effective. |

### `task-thread`

Automated: [interaction cards](../../ui/src/components/IssueThreadInteractionCard.test.tsx),
[paged task cards](../../ui/src/components/task-chat/TaskChatInteractionCard.test.tsx),
and [task thread](../../ui/src/components/TaskChatThread.test.tsx) cover form,
receipt, and dismissal behavior. [Resolution routes](../../server/src/__tests__/issue-thread-interaction-routes.test.ts)
and [response delivery](../../server/src/__tests__/question-response-delivery.test.ts)
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

Automated: the [task thread suite](../../ui/src/components/TaskChatThread.test.tsx)
parameterizes unanswered-question history for conversation mode on and off.
This proves component parity, not a model's plan handoff.

Manual: repeat dismissal, reload, reopening, and answer submission in Chat.
Approve a plan and inspect the linked execution task and copied plan. The chat
history remains and the conversation does not close as a completed task.

### `attention`

Automated: [attention resolver](../../ui/src/components/AttentionInteractionResolver.test.tsx)
covers preparing-request refresh without accepting it. The resolution-route
tests above cover the API, not every Decisions or Inbox navigation path.

Manual: open the same pending request in an attention row and task tab. Resolve
from the row; both surfaces must settle after refresh. Check an empty queue,
loading, permission denial, and a stale request. Repeat with combined Inbox/Tasks
on when that surface is part of the change. Full navigation parity remains a
manual coverage gap.

### `board-approval`

Automated: [approval service](../../server/src/__tests__/approvals-service.test.ts)
and [idempotency routes](../../server/src/__tests__/approval-routes-idempotency.test.ts)
cover persistence and duplicate decisions. They do not drive the approval pages.

Manual: create disposable formal approval requests; approve one from the list,
reject another from details, and request revision on a third. Resubmit that
third request and verify Pending/All and detail history after reload. Confirm
the recorded decision and its governed effect, not just a success toast.

### `app-review`

Automated: [connection reviews](../../tests/e2e/connection-reviews.spec.ts) drives
task/queue synchronization, approve, decline, remembered permission, provider
failure, and restart with a scripted process agent and local MCP provider:

```sh
pnpm exec playwright test -c tests/e2e/connection-reviews.config.ts
```

Manual: dismiss and reopen a review, decide it from each entry point using fresh
requests, and inspect the continuation's useful result. Always allow must show
its scope; a future action with changed arguments should obey the saved rule.
Provider failure must remain an approved decision with a failed execution.
Real provider and model checks follow [Task reviews](../../doc/connections/TASK-REVIEWS.md#verification-workflows).

### `skill-test`

Automated: [read-only interaction contract](../../server/src/__tests__/issue-thread-interaction-routes.test.ts)
checks that fetching interactions does not mutate them. Shared card suites cover
rendering. Neither proves the complete Skill Studio host or its permission matrix.

Manual: run a skill test with a question, answer through its visible output,
and inspect the test result. Attempt a governed action outside the test's scope;
expect denial. The complete Skill Studio browser journey is not covered by the
referenced unit tests.

### `external-channel`

Automated: [chat question forms](../../server/src/services/chat-question-forms.test.ts),
[Discord forms](../../server/src/services/chat-discord-question-forms.test.ts),
and [interaction publications](../../server/src/__tests__/chat-interaction-publications.test.ts)
cover serialization and delivery logic with fixtures.

Free-text and multi-question cards must show their title, question prompts, help
text, and relevant context beside Respond. Settled cards must not expose saved
free-text answers. The interaction publication database suite covers both states.

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

### Documentation scope: Formal governance approvals

Formal board decisions and signoff have recipes; every approval payload/type and actor/host error permutation is not enumerated.
