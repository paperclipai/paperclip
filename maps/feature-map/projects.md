---
navigation: {"section":"Projects and execution","sectionOrder":40,"order":10}
---

# Projects and repositories

People group tasks into projects, attach goals and repositories, and configure the context and defaults used by project work.

Feature ID: `projects`.

Implementation: [project list](../../ui/src/pages/Projects.tsx), [project detail](../../ui/src/pages/ProjectDetail.tsx).

Agent access: [companion](../agent-access-map/projects.md).

## Sub-features

- `lifecycle`: `projects/lifecycle` — create, name, organize, and archive projects.
- `task-context`: `projects/task-context` — inspect project tasks and create work in the selected project.
- `repositories`: `projects/repositories` — configure repository/workspace sources and verify usable checkouts.
- `defaults`: `projects/defaults` — maintain project instructions, environment, goal, and budget context where offered.
- `privacy`: `projects/privacy` — create private projects, inspect access members, and manage their audience without publishing protected tasks.

## How to get to it (user POV)

### `project-list`

Open `/projects`, create a project, and enter its overview or Issues view.

### `repository-settings`

Open `/projects/:projectId/configuration` and its repository/workspace settings.
Workspace storage shows the inherited installed default and allows an explicit
provider or Core/local choice. Conflicting defaults remain visible for repair.

### `project-access`

Open `/projects/:projectId/configuration`, use **Private project**, and choose **Manage access** or **View access** according to your authority. Create a private project through the supported creation surface or API when needed for a fixture.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a disposable project and a small repository you can access; record checkout and credential ownership.

### `project-list`

Automated: [projects UI](../../ui/src/pages/Projects.test.tsx) and [project detail](../../ui/src/pages/ProjectDetail.test.tsx) are component tests.

Manual: Create a project, add a task from its view, and reload. Verify the task belongs to that project, list counts are plausible, and links preserve company scope. Archive only the disposable project and inspect list/task behavior.

### `repository-settings`

Automated: [provider defaults and API overrides](../../server/src/__tests__/project-workspace-provider.integration.test.ts) and [storage selection UI](../../ui/src/components/ProjectProperties.concurrency.test.tsx) cover inherited choices, explicit overrides, and configuration errors. These offline checks do not qualify live provider storage.

Custom GitHub Apps (2026-10-25): the repository picker includes verified,
explicitly configured repositories from company-owned App grants for active
company members or the local trusted board. Personal App metadata belongs to its
owner; shared App metadata follows its human audience. Selection stores repository
identity and URL without granting runtime credentials or repository-content
access. Provider-fixture coverage lives in
[repository persistence](../../server/src/__tests__/project-repositories-persistence.test.ts);
live App checkout remains a separate acceptance requirement.

Automated: [repository persistence](../../server/src/__tests__/project-repositories-persistence.test.ts) and [repository browser suite](../../tests/e2e/project-repositories.spec.ts) cover configured repository workflows.

Manual: Attach a small repository, save, and create a project task. Inspect the actual checkout/revision used by its run. Test an invalid repository and missing credentials without treating a saved URL as a working workspace.

### `project-access`

Automated: [Privacy production review](../../server/src/__tests__/privacy-production-review.test.ts) covers persisted project audience changes, task inheritance, and actor intersections. [Privacy controls](../../ui/src/components/PrivateTaskPrivacyControls.test.tsx) covers UI controls and task-cache invalidation after membership removal. These tests do not prove both people’s live navigation.

Manual: As an ordinary authenticated project owner, create a private project and task. Add another company person and an eligible agent through Manage access, reload, and inspect their project discovery and task reads. The added person can view members but cannot change the audience. Remove them, reload their session, and retry direct project/task links. Confirm removing the owner is unavailable or rejected. Add a direct grant for one private task, then open the project to the company after inspecting the confirmation. Verify the project becomes discoverable, protected tasks remain private, and project-derived task access no longer substitutes for direct task access. Test the agent and its responsible person separately.

Sources: [Project properties](../../ui/src/components/ProjectProperties.tsx), [access members](../../ui/src/components/ProjectAccessMembers.tsx), [project routes](../../server/src/routes/projects.ts), and [authorization](../../server/src/services/authorization.ts).

## Gotchas

- A private project’s member list is readable to an authorized project reader. Task access-grant inspection has a stricter management boundary.

- `/overview` now selects Configuration, not a distinct overview page. Personal
  join/leave and star controls have their own persistence and should be checked
  when affected; **Star/Unstar {project name}** is the visible star action.
- Project name slugs change on rename and have no historical alias lookup.
  Reopen a renamed project through its stable UUID route, wait for the current
  Configuration form, and record the newly normalized URL before reloading.

- Project repository configuration and a provisioned execution workspace are different records.
- See [workspaces](./workspaces.md), [goals](./goals.md), and [budgets](./budgets-costs.md) for those features.
- Do not assume a deleted or archived project should erase its historical task evidence.

### Automatic repository skills

Creating or attaching a GitHub repository enqueues skill import without another setup
step. Check Skills → Sources and the installed library afterward. Ordinary edits to
older projects do not adopt their repositories; explicit adoption belongs in Sources.
Removing a repository retains installed skills and originating project access but stops
its automatic tracking. Changing the ref does not retarget existing skill references.

### Documentation scope: Projects and execution workspaces

Provider-specific provisioning, multi-repository/submodule edge cases, Git reconciliation variants, and all service exposure combinations require deeper recipes.
