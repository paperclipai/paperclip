---
navigation: {"section":"Tasks and conversations","sectionOrder":20,"order":20}
---

# Delegation, dependencies, and signoff

A larger task can coordinate child work, dependencies, reviewers, and execution controls while preserving a clear owner and a traceable completion decision.

Feature ID: `task-coordination`.

Implementation: [task thread](../../ui/src/pages/IssueDetail.tsx), [execution policy](../../server/src/services/issues.ts).

Agent access: [companion](../agent-access-map/task-coordination.md).

## Sub-features

- `delegation`: `task-coordination/delegation` — inspect parent/child tasks and the original request behind delegated work.
- `dependencies`: `task-coordination/dependencies` — show blocking tasks and wake eligible work when prerequisites resolve.
- `signoff`: `task-coordination/signoff` — apply the configured implementation/review completion policy.
- `tree-control`: `task-coordination/tree-control` — pause or resume a task tree without bypassing its gates.

## How to get to it (user POV)

### `task-relationships`

Open the task’s parent/child and dependency links in task detail.

The task feed shows a linked card when an agent creates a direct subtask or a
follow-up task from that task. The card stays at its creation time beside
documents and artifacts. It shows the current task title, number, and status.
The Tasks tab retains the complete relationship list.

### `review-and-controls`

Inspect the task’s execution policy and available review, pause, resume, or stop controls.

## Driving it with Playwright and the Paperclip API

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Prepare a parent, child, and dependent task plus implementer/reviewer agents. Record execution policy and use a disposable tree.

Parent/dependency navigation and inherited tree holds can be checked on unassigned
tasks. Agents are required for the continuation and signoff portion. A tree pause
creates a hold; it does not change task statuses to a paused status.

### `task-relationships`

Automated: [dependency wakeups](../../server/src/__tests__/issue-dependency-wakeups-routes.test.ts) checks server behavior; visual relationship navigation remains a manual check.

The [created task card stories](../../ui/storybook/stories/task-coordination/task-created-inline.stories.tsx)
render the production feed with fixture task reads. The
[task feed tests](../../ui/src/components/TaskChatThread.task-creation-order.test.tsx)
check creation order, current status, links, and duplicate suppression.

Manual: Block one task on another, finish the prerequisite, and observe the dependent task’s eligible continuation. Follow parent/child links back to the source request. Verify no duplicate run or false parent completion occurs.

### `review-and-controls`

Automated: [execution policy](../../server/src/__tests__/issue-execution-policy.test.ts), [tree control](../../server/src/__tests__/issue-tree-control-service.test.ts), and [signoff browser suite](../../tests/e2e/signoff-policy.spec.ts) target these layers. A linked suite is not a claim that its current run is green.

Manual: Complete implementation under a review-required policy and confirm it waits for the required review outcome. Exercise rejection and later approval. Pause the parent while child work is pending, then verify resumption respects budget and ownership gates.

Resume removes the pause without changing task status. Its wake count includes only
current agent assignees on todo, in-progress, or in-review tasks. The dialog explains
that blocked, backlog, and unassigned tasks remain idle. Verify this in both task
interfaces with [the paused composer browser suite](../../tests/e2e/paused-composer.spec.ts).
Release rechecks tasks reopened after the pause; another active pause still prevents
their execution, and uncertain prior executions must be reconciled before waking.

### Plugin task panels

An installed plugin can offer an agent detail tab in the task side panel through
its optional `taskSidePanel` declaration. The launcher offers that view for the
running agent, or the task's assigned agent when idle. Manual selection mounts
the same authorized viewer used on the agent page and needs no activity event.
The view remains selectable after the run ends.

A declared activation pair controls automatic opening. The runtime captures
Runner context before use and records `runtime.activity.recorded` after success.
Core maps that namespace/activity key to the declaration and restores it from
the run log on reload or reconnect. After matching activity, readiness gets
three bounded attempts with no periodic availability poll. A ready view opens
the pane and selects its tab once per run, respecting dismissal during that run.
Declarations without a mapping support manual selection. Plugins own viewer
content, readiness, and authorization. Missing or disabled plugins add no view.

Implementation: [panel discovery](../../ui/src/hooks/useTaskPluginPanels.ts) and
[task panel](../../ui/src/components/task-side-panel/TaskSidePanel.tsx).
Automated: [discovery tests](../../ui/src/hooks/useTaskPluginPanels.test.tsx) and
[task panel tests](../../ui/src/components/task-side-panel/TaskSidePanel.test.tsx)
cover availability, task/agent changes, failures, inactivity and dismissal.
These mocks do not establish a particular plugin's live transport behavior.

## Gotchas

- Review completion and task completion are different events under some policies.
- Pausing a tree must not be “tested” by changing statuses until the screen looks quiet.
- Use [questions and approvals](./questions-and-approvals.md) for decision forms and [recovery](./recovery.md) for interrupted work.
