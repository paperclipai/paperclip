# Delegation, dependencies, and signoff

A larger task can coordinate child work, dependencies, reviewers, and execution controls while preserving a clear owner and a traceable completion decision.

Implementation: [task thread](../ui/src/pages/IssueDetail.tsx), [execution policy](../server/src/services/issues.ts).

## Sub-features

- `delegation`: inspect parent/child tasks and the original request behind delegated work.
- `dependencies`: show blocking tasks and wake eligible work when prerequisites resolve.
- `signoff`: apply the configured implementation/review completion policy.
- `tree-control`: pause or resume a task tree without bypassing its gates.

## How to get to it (user POV)

### `task-relationships`

Open the task’s parent/child and dependency links in task detail.

### `review-and-controls`

Inspect the task’s execution policy and available review, pause, resume, or stop controls.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Prepare a parent, child, and dependent task plus implementer/reviewer agents. Record execution policy and use a disposable tree.

### `task-relationships`

Automated: [dependency wakeups](../server/src/__tests__/issue-dependency-wakeups-routes.test.ts) checks server behavior; visual relationship navigation remains a manual check.

Manual: Block one task on another, finish the prerequisite, and observe the dependent task’s eligible continuation. Follow parent/child links back to the source request. Verify no duplicate run or false parent completion occurs.

### `review-and-controls`

Automated: [execution policy](../server/src/__tests__/issue-execution-policy.test.ts), [tree control](../server/src/__tests__/issue-tree-control-service.test.ts), and [signoff browser suite](../tests/e2e/signoff-policy.spec.ts) target these layers. A linked suite is not a claim that its current run is green.

Manual: Complete implementation under a review-required policy and confirm it waits for the required review outcome. Exercise rejection and later approval. Pause the parent while child work is pending, then verify resumption respects budget and ownership gates.

## Gotchas

- Review completion and task completion are different events under some policies.
- Pausing a tree must not be “tested” by changing statuses until the screen looks quiet.
- Use [questions and approvals](./questions-and-approvals.md) for decision forms and [recovery](./recovery.md) for interrupted work.
