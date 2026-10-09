# Goals and work alignment

People define company and lower-level goals and connect projects and tasks to the outcome they serve.

Implementation: [goals](../ui/src/pages/Goals.tsx), [goal detail](../ui/src/pages/GoalDetail.tsx).

## Sub-features

- `hierarchy`: create and inspect goal level, parent, owner, and status.
- `alignment`: associate work with a valid goal in the same company.
- `navigation`: follow goal/project/task context to understand why work exists.

## How to get to it (user POV)

### `goal-detail`

Open `/goals`, create a goal, and enter `/goals/:goalId`.

### `task-goal-context`

Inspect the goal context from a project or task and compare explicit versus inherited context.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Prepare two goals and a disposable project/task in the selected company.

### `goal-detail`

Automated: [project-goal validation](../server/src/__tests__/project-goal-validation.test.ts) covers relationship validation; [goal detail control](../ui/src/pages/GoalDetail.test.tsx) only tests the properties toggle, not the whole creation journey.

Manual: Create a parent and child goal, save owner/status changes, and reload. Link a project and task through the offered controls, follow their goal context, and verify a cross-company or invalid relationship is rejected.

### `task-goal-context`

Automated: [task goal routes](../server/src/__tests__/issues-goal-context-routes.test.ts) and [goal fallback](../server/src/__tests__/issue-goal-fallback.test.ts) cover the server rules.

Manual: Compare a task with an explicit goal to one relying on project context. Change the allowed association, reload, and verify the displayed/injected context follows the documented server rule rather than retaining an unrelated goal.

## Gotchas

- A goal status is not an independently measured proof of business success.
- Do not infer a complete goal browser test from the small properties-toggle suite.
