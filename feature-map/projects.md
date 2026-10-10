# Projects and repositories

People group tasks into projects, attach goals and repositories, and configure the context and defaults used by project work.

Implementation: [project list](../ui/src/pages/Projects.tsx), [project detail](../ui/src/pages/ProjectDetail.tsx).

## Sub-features

- `lifecycle`: create, name, organize, and archive projects.
- `task-context`: inspect project tasks and create work in the selected project.
- `repositories`: configure repository/workspace sources and verify usable checkouts.
- `defaults`: maintain project instructions, environment, goal, and budget context where offered.

## How to get to it (user POV)

### `project-list`

Open `/projects`, create a project, and enter its overview or Issues view.

### `repository-settings`

Open `/projects/:projectId/configuration` and its repository/workspace settings.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a disposable project and a small repository you can access; record checkout and credential ownership.

### `project-list`

Automated: [projects UI](../ui/src/pages/Projects.test.tsx) and [project detail](../ui/src/pages/ProjectDetail.test.tsx) are component tests.

Manual: Create a project, add a task from its view, and reload. Verify the task belongs to that project, list counts are plausible, and links preserve company scope. Archive only the disposable project and inspect list/task behavior.

### `repository-settings`

Automated: [repository persistence](../server/src/__tests__/project-repositories-persistence.test.ts) and [repository browser suite](../tests/e2e/project-repositories.spec.ts) cover configured repository workflows.

Manual: Attach a small repository, save, and create a project task. Inspect the actual checkout/revision used by its run. Test an invalid repository and missing credentials without treating a saved URL as a working workspace.

## Gotchas

- Project repository configuration and a provisioned execution workspace are different records.
- See [workspaces](./workspaces.md), [goals](./goals.md), and [budgets](./budgets-costs.md) for those features.
- Do not assume a deleted or archived project should erase its historical task evidence.
