# Task creation and lifecycle

People create, assign, organize, discuss, and finish tasks. A task retains its owner, project, priority, history, and outputs as it moves through the work lifecycle.

Implementation: [new task](../ui/src/components/NewIssueDialog.tsx), [task list](../ui/src/pages/Issues.tsx), [task detail](../ui/src/pages/IssueDetail.tsx).

## Sub-features

- `create`: capture a title/request with the intended agent, project, and attachments.
- `organize`: filter, sort, group, and navigate tasks without losing the selected context.
- `properties`: change status, priority, assignee, project, and relationships where authorized.
- `discussion`: persist comments, references, and files on the task.
- `completion`: distinguish backlog, active work, review, blocked, done, and cancelled outcomes.

## How to get to it (user POV)

### `new-task`

Use New task from the global launcher, task list, or project task view.

### `task-list`

Open `/issues` or a project’s Issues view; legacy `/tasks` links redirect.

### `task-detail`

Open `/issues/:issueId` from a row, mention, or direct link.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use an invokable test agent and a project; record whether a real or simulated harness handles the request.

### `new-task`

Automated: [creation dialog](../ui/src/components/NewIssueDialog.test.tsx) is component coverage with mocked requests.

Manual: Create a uniquely named task with an agent and project. Open its resulting link and reload. Confirm text, attachment, assignment, and project persisted, and verify execution started only when the task and agent are eligible.

### `task-list`

Automated: [task list](../ui/src/pages/Issues.test.tsx) covers UI behavior; list variants still need a running-browser check.

Manual: Filter by status and assignee, change grouping/sort, open a task, and return. Verify the correct records and selected view survive navigation and reload. Include an empty result and a failed request.

### `task-detail`

Automated: [task detail](../ui/src/pages/IssueDetail.test.tsx) covers component behavior, while [issue service](../server/src/__tests__/issues-service.test.ts) covers server contracts.

Manual: Add a comment and edit authorized properties. Reload and verify history, actor, and values. Complete a disposable task and inspect its deliverable; reopen through an available action and confirm the next execution follows current policy.

## Gotchas

- A status label alone does not prove that the requested work exists.
- Single-assignee and atomic checkout rules still apply when tasks are created from different hosts.
- Use [coordination](./task-coordination.md), [steering](./steering.md), and [documents](./documents-artifacts.md) for their distinct workflows.
