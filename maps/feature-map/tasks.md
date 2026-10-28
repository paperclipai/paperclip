---
navigation: {"section":"Tasks and conversations","sectionOrder":20,"order":10}
---

# Task creation and lifecycle

People create, assign, organize, discuss, and finish tasks. A task retains its owner, project, priority, history, and outputs as it moves through the work lifecycle.

Feature ID: `tasks`.

Implementation: [new task](../../ui/src/components/NewIssueDialog.tsx), [task list](../../ui/src/pages/Issues.tsx), [task detail](../../ui/src/pages/IssueDetail.tsx).

Agent access: [companion](../agent-access-map/tasks.md).

## Sub-features

- `create`: `tasks/create` — capture a title/request with the intended agent, project, and attachments.
- `organize`: `tasks/organize` — filter, sort, group, and navigate tasks without losing the selected context.
- `properties`: `tasks/properties` — change status, priority, assignee, project, and relationships where authorized.

- `discussion`: `tasks/discussion` — persist comments, references, and files on the task.
- `completion`: `tasks/completion` — distinguish backlog, active work, review, blocked, done, and cancelled outcomes.
- `privacy`: `tasks/privacy` — create private tasks, share or revoke access, and inspect parent/project inheritance before changing visibility.

The [Product task-properties journey](../../tests/runner-e2e/PRODUCT-JOURNEYS.md)
checks only assignment to the signed-in user and persistence after reload. Its
source is reusable across self-hosted and Cloud; Cloud live qualification is
separate. It does not cover other property operations or agent authorization.

## How to get to it (user POV)

Cold collection loads use a lightweight index and batched hierarchy context,
then fetch diagnostic details for visible rows. Delay the index, hierarchy, and
visible-row details independently when verifying `tasks/organize`: row heights,
title bounds, and the first-row origin should remain stable. Test nested expansion,
scrolling to more rows, and detail/back navigation; a collection projection must
never suppress the full task instruction fetch.

### `new-task`

Use New task from the global launcher, task list, or project task view.

### `task-list`

Open `/issues` or a project’s Issues view; legacy `/tasks` links redirect.

### `task-detail`

Open `/issues/:issueId` from a row, mention, or direct link. Cold opens show the instruction and recent exchange first. **More messages** appears only when earlier comments or runs are omitted and loads that history. Fresh tasks with no omitted history have no disclosure. A single legacy run with a truncated log offers **More run output** instead. **More task actions → Show task activity** loads full activity even for a single native run; incoming messages remain visible while the task stays open.

### `task-sharing`

Use the privacy control in New task, or open an existing task’s menu and choose **Make private**, **Share…**, or **Make public** where allowed. The share sheet lists direct grants and inherited access from private ancestors or project membership. Inherited rows have no local revoke action; manage that access at its source.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a
disposable project. Persistence checks can assign work to Me or leave it
unassigned; execution checks additionally need an invokable test agent. Record
whether a real or simulated harness handles execution.

**Operation checkpoints**

Use these checks alongside the entry-point recipes below and the operation records in the [access companion](../agent-access-map/tasks.md). Record the actual actor, surface, saved result and denial separately. Source review and linked tests do not establish a live pass.

| Capability ID | Action and persisted result | Denial, race and retry checks |
| --- | --- | --- |
| `tasks/create` | Create an unassigned task or assign it to Me; save its description and context, then reopen and reload the exact task. | Exercise required fields, inaccessible parents/projects, and the same API creation key with identical and changed input. Compare task IDs and run counts; saving a draft is not creation. |
| `tasks/organize` | Find the saved task through list, project, filter, and direct-link surfaces; change supported labels separately. | Compare another actor’s private results and another company. Distinguish browser sorting/grouping preferences from saved task data. |
| `tasks/properties` | Change title, metadata, assignee, dependencies, work mode, execution settings, and monitor/watchdog configuration as separate operations. Reload each saved change. | Use an occupied checkout, stale status version, invalid dependency, stopped run, and disallowed mode. Check the specific rejection and unchanged fields; a successful title edit does not establish assignment authority. |
| `tasks/discussion` | Post a unique comment, reload, and inspect attribution. Read history, inspect a queued message, and delete only an owned disposable comment where allowed. | Separate an ordinary comment from steering or a wake. Check inaccessible task history, author-only deletion, queued cancellation, and duplicate delivery. Feedback votes have their own human authority. |
| `tasks/completion` | Complete, block, request review, reopen, and cancel separate disposable tasks through offered controls. Inspect the saved outcome, review gates, and execution state. | Test pending dependencies/reviews, a stale or active checkout, and late writes after handoff. Terminal status does not prove provider stop or saved files. Verify checkout/release and destructive deletion separately from completion. |
| `tasks/privacy` | Create private work with a responsible person; share a child, inspect direct/inherited rows, revoke a direct grant, and check publication constraints. | Use separate ordinary people and an actual agent. Shared readers cannot manage grants; ancestor/project access changes at its source. Reload and retry discovery/direct reads after revocation; keep unrelated direct grants. |

### `new-task`

Automated: [board dialogs](../../ui/src/components/BoardDialogs.test.tsx) checks that the task form appears on the first synchronous open and retains its draft across reopen. [Creation dialog](../../ui/src/components/NewIssueDialog.test.tsx) covers typing while agent/project requests are pending and retaining that text when defaults arrive. These are component checks with mocked requests.

Manual: Create a uniquely named task with an agent and project. Open its resulting link and reload. Confirm text, attachment, assignment, and project persisted, and verify execution started only when the task and agent are eligible.

On the first New task open after a page load, confirm the form appears without a loading dialog. Delay agent and project responses, type a request, then release the responses. Confirm the choices populate without replacing the form or its text.

Creation is request-first: enter **Describe a task…**, choose the assignee and
project, and submit **Create task**. A standalone title field is not always shown.
Use a human/unassigned task to verify persistence without invoking a model.

### `task-list`

Automated: [task-list helpers](../../ui/src/pages/Issues.test.tsx) cover search URLs, pagination, deduplication, and presentation constants. The suite does not render the page or exercise filtering, grouping, opening a task, and returning; those interactions still need a running-browser check.

Task and inbox rows omit the system interruption labels **Thinking**, **Trying again soon**, and **Retry available**. [Shared row tests](../../ui/src/components/IssueRow.test.tsx) cover working, scheduled-retry, and failed interruptions in both row presentations, including suppression of replacement recovery chips. Task status and other relevant badges remain visible; retry controls remain inside the task conversation.

Manual: Seed human-created, agent-created, scheduled routine, human-initiated chat-channel, and creator-less tasks. Confirm automation is hidden by default, **show agent-created tasks** reveals it, reload preserves the choice, and Clear filters hides it again. Verify list and board search with automation newer than the human results, and expand contextual ancestors/subtasks without promoting unrelated automated roots. Repeat in project task lists. Agent profiles and task-detail subtasks retain complete history.

Manual: Filter by status and assignee, change grouping/sort, open a task, and return. Verify the correct records and selected view survive navigation and reload. Include an empty result and a failed request.

### `task-detail`

Manual: Open a long task with slow historical requests. Read the instruction and recent reply before those requests finish. Edit the title/status while enrichment is pending and verify saves and rollbacks. Expand **More messages**, verify scroll position and no duplicate replies, return to the task, and follow an older comment link. Leave a task open across new messages and runs and confirm none disappear. Reconnect after several turns and verify watched runs settle. Reopen after steering with more than 50 newer activity rows; the delivered message must not reappear in the queue.

Automated: [cold-open reads](../../server/src/__tests__/task-cold-open.test.ts) cover bounded reads, event filtering and company denial. [Task detail](../../ui/src/pages/IssueDetail.test.tsx) covers component behavior, while [issue service](../../server/src/__tests__/issues-service.test.ts) covers server contracts.

Failure markers have no dashed divider rules. An adjacent run error and
no-live-execution-path notice show only the last error, with its details and
retry action, including a permitted legacy run retry carried onto a later
recovery notice. Intervening messages, unrelated system notices that quote error
text, and credential-access denials stay visible. Explicit non-recovery titles
stop grouping. Saved stranded-recovery action metadata plus a known recovery
statement also identify recovery notices with a default or source-run title.
Only known recovery statements use the legacy text fallback.
[Grouping tests](../../ui/src/components/task-chat/adjacent-errors.test.ts) and
[marker tests](../../ui/src/components/task-chat/TaskChatMarker.test.tsx) cover
the presentation. The [Failure notices stories](../../ui/storybook/stories/tasks/failure-notices.stories.tsx)
mount the production thread view with fixture data. The focused
[browser suite](../../tests/storybook-visual/failure-notices.spec.ts) checks
play assertions, disclosure, retry callbacks, themes and phone width. These
checks do not dispatch a real retry or change stored run history.

Automated: [paused assignee relevance](../../tests/e2e/completed-task-paused-assignee.spec.ts)
uses a real disposable server and paused process agent, with no inference, to
check both task interfaces. Done and cancelled tasks hide the paused-agent
warning; reopening restores it. The agent stays paused and no run starts.

Manual: For a disposable task owned by a legacy agent, have its current run
assign the task to a human with status In review. Verify that assignment and
status persist, that the current run finishes without `issue_reassigned`, and
that slow workspace restoration does not turn the task Blocked. Try a later edit
from the outgoing run and verify rejection. Repeat a board
reassignment and confirm that the outgoing run still stops.

Manual: Add a comment and edit authorized properties. Reload and verify history, actor, and values. Complete a disposable task and inspect its deliverable; reopen through an available action and confirm the next execution follows current policy.

Manual: Ask a standard native agent to schedule a future check on its current
task. Reload and confirm the persisted monitor. After the agent yields, verify
one later wake and a consumed schedule. For malformed-call recovery, use the
[agent access recipe](../agent-access-map/tasks.md#properties) and verify that
schema feedback supports a corrected call before a wait is claimed.
For a due monitor held by execution recovery, confirm that the schedule remains
and task activity explains the deferral. Repeated checks must not replay the held
work. Resolve the hold through its existing recovery action, then verify one wake.
On a blocked task with a retained monitor, verify that automatic checks show as
paused. Check now requests one check through normal admission without changing
the task status. Confirm that an unresolved dependency or recovery hold prevents
dispatch and does not produce a success message. Backlog and todo tasks must not
offer Check now. Blocked provider-quota recovery must offer no manual check and
retain its schedule until the task resumes. Agents and automatic ticks cannot
check a blocked task.
Hold native finalization after the provider has stopped, and verify that both
scheduled and manual checks retain the due monitor. After settlement, verify one
wake. If its timeout passes during workspace recovery, verify settlement followed
by the configured expiry recovery, with no ordinary monitor wake or duplicate
escalation. For a timer already dispatched before recovery, verify that the saved
result settles without changing the task, removing a successor's checkout, or
creating another wake. The [monitor regression](../../server/src/services/native-runtime/task-monitor.integration.test.ts)
and [scheduler regression](../../server/src/services/heartbeat/scheduling.test.ts)
cover these boundaries with PostgreSQL.

Manual: Add an ordinary Board comment while a task retry is queued or running.
Confirm that the same execution keeps working and receives the saved message,
without a second executor or an implicit move to Todo. Repeat with a parked retry
and verify that fresh instructions can supersede it. Explicit Stop must still
cancel active work. The [comment route regressions](../../server/src/__tests__/issue-comment-reopen-routes.test.ts)
and [HTTP/process and interrupted-cancellation tests](../../server/src/__tests__/issue-scheduled-retry-routes.test.ts)
cover these boundaries locally; deployed runner acceptance remains separate.

### `task-sharing`

Automated: [Share sheet](../../ui/src/components/IssueShareSheet.test.tsx), [privacy controls](../../ui/src/components/PrivateTaskPrivacyControls.test.tsx), [grant routes](../../server/src/__tests__/issue-access-grants-routes.test.ts), and [privacy production review](../../server/src/__tests__/privacy-production-review.test.ts) cover component actions, persisted grants, inheritance, and actor/resource denials. They do not establish a live two-person browser journey.

Manual: Use authenticated mode with two ordinary operators, an eligible agent, and disposable parent/child/sibling tasks. Create private work as the first person; confirm the second person cannot discover or cold-open it. Share only the child, reload both sessions, and verify child/descendant access without exposing the private parent, sibling, or unreadable project metadata. Inspect direct and inherited rows in Share; inherited rows must identify access managed at its source and offer no local revoke action. Confirm a shared reader cannot manage the task’s grants. Revoke the direct grant as its manager, reload, and retry list and direct reads; change inherited access at its ancestor or project source separately. Inspect blocked Make public actions under a private parent or nonpersonal private project; separately confirm the offered personal-project publish action removes that project binding while private descendants remain private. With an actual granted agent, test the responsible user’s access intersection and the allowed restriction to private; agent access must not permit sharing or publishing.

Sources: [Privacy actions](../../ui/src/components/IssuePrivacyActions.tsx), [share sheet](../../ui/src/components/IssueShareSheet.tsx), [issue routes](../../server/src/routes/issues.ts), and [authorization](../../server/src/services/authorization.ts).

## Gotchas

- Private task sharing and private project membership are distinct read sources. Revoking a direct task grant does not revoke an independent ancestor/project grant; inspect the actual access source.

- Priority remains an API field, but ordinary priority UI editing is hidden.

- A status label alone does not prove that the requested work exists.
- Single-assignee and atomic checkout rules still apply when tasks are created from different hosts.
- Use [coordination](./task-coordination.md), [steering](./steering.md), and [documents](./documents-artifacts.md) for their distinct workflows.

### Documentation scope: Tasks, conversations, and attention

Recipes cover the main task/conversation/attention workflows. Full shell, permission, attachment, long-thread, and concurrency permutations remain to be enumerated.
