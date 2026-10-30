---
navigation: {"section":"Projects and execution","sectionOrder":40,"order":20}
---

# Goals and work alignment

People define company and lower-level goals and connect projects and tasks to the outcome they serve.

Feature ID: `goals`.

Implementation: [goals](../../ui/src/pages/Goals.tsx), [goal detail](../../ui/src/pages/GoalDetail.tsx).

Agent access: [companion](../agent-access-map/goals.md).

## Sub-features

- `hierarchy`: `goals/hierarchy` — create and inspect goal level, parent, owner, and status.
- `alignment`: `goals/alignment` — associate work with a valid goal in the same company.
- `navigation`: `goals/navigation` — follow goal/project/task context to understand why work exists.

## How to get to it (user POV)

### `goal-detail`

Open `/goals`, create a goal, and enter `/goals/:goalId`.

### `task-goal-context`

Inspect the goal context from a project or task and compare explicit versus inherited context.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Prepare two goals and a disposable project/task in the selected company.

### `goal-detail`

Automated: [project-goal validation](../../server/src/__tests__/project-goal-validation.test.ts) covers relationship validation; [goal detail control](../../ui/src/pages/GoalDetail.test.tsx) only tests the properties toggle, not the whole creation journey.

Manual: Choose **Add Goal/New Goal**, enter **Goal title**, select the level, and
create a parent. Open it and choose **Sub Goal** to create a child with the
parent preselected. Change status in Properties and reload; follow the Parent
Goal link and inspect Sub-Goals. Owner is currently display-only in this UI.
Link a project and task through the offered controls, follow their goal context,
and verify a cross-company or invalid relationship is rejected.

### `task-goal-context`

Automated: [task goal routes](../../server/src/__tests__/issues-goal-context-routes.test.ts) and [goal fallback](../../server/src/__tests__/issue-goal-fallback.test.ts) cover the server rules.

Manual: Compare a task with an explicit goal to one relying on project context. Change the allowed association, reload, and verify the displayed/injected context follows the documented server rule rather than retaining an unrelated goal.

## Gotchas

- A goal status is not an independently measured proof of business success.
- Do not infer a complete goal browser test from the small properties-toggle suite.

### Storybook verification

#### `alignment`

Capability ID: `goals/alignment`.

Scope: ui
Storybook: Project/task goal selection, explicit/inherited context and invalid association error.
Production: Persist same-company valid association, reject invalid/cross-company reference, verify explicit versus inherited server context after reload.
Sources: Source: [ProjectProperties.tsx](../../ui/src/components/ProjectProperties.tsx), [GoalDetail.tsx](../../ui/src/pages/GoalDetail.tsx). Tests: [project-goal-validation.test.ts](../../server/src/__tests__/project-goal-validation.test.ts), [issues-goal-context-routes.test.ts](../../server/src/__tests__/issues-goal-context-routes.test.ts), [issue-goal-fallback.test.ts](../../server/src/__tests__/issue-goal-fallback.test.ts), [project-goal.test.ts](../../cli/src/__tests__/project-goal.test.ts)

#### `navigation`

Capability ID: `goals/navigation`.

Scope: ui
Storybook: Parent/child goal and project/task context links, empty/unavailable context and permitted destination.
Production: Follow actual goal/project/task records and compare explicit versus inherited context; ensure reload and inaccessible destination behavior.
Sources: Source: [GoalDetail.tsx](../../ui/src/pages/GoalDetail.tsx), [GoalProperties.tsx](../../ui/src/components/GoalProperties.tsx). Tests: [GoalDetail.test.tsx](../../ui/src/pages/GoalDetail.test.tsx), [issues-goal-context-routes.test.ts](../../server/src/__tests__/issues-goal-context-routes.test.ts), [issue-goal-fallback.test.ts](../../server/src/__tests__/issue-goal-fallback.test.ts)

### Documentation scope: Goals, dashboards, costs, and activity

Core goal/report/budget/audit journeys are mapped. Every aggregation/filter combination, cost source, and overlapping budget window still needs dedicated cases.
