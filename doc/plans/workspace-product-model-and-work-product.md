# Workspace Product Model, Work Product, and PR Flow

## Context

Paperclip needs to support two very different but equally valid ways of working:

- a solo developer working directly on `master`, or in a folder that is not even a git repo
- a larger engineering workflow with isolated branches, previews, pull requests, and cleanup automation

Today, Paperclip already has the beginnings of this model:

- `projects` can carry execution workspace policy
- `project_workspaces` already exist as a durable project-scoped object
- issues can carry execution workspace settings
- runtime services can be attached to a workspace or issue

What is missing is a clear product model and UI that make these capabilities understandable and operable.

The main product risk is overloading one concept to do too much:

- making subissues do the job of branches or PRs
- making projects too infrastructure-heavy
- making workspaces so hidden that users cannot form a mental model
- making Paperclip feel like a code review tool instead of a control plane

## Goals

1. Keep `project` lightweight enough to remain a planning container.
2. Make workspace behavior understandable for both git and non-git projects.
3. Support three real workflows without forcing one:
   - shared workspace / direct-edit workflows
   - isolated issue workspace workflows
   - long-lived branch or operator integration workflows
4. Provide a first-class place to see the outputs of work:
   - previews
   - PRs
   - branches
   - commits
   - documents and artifacts
5. Keep the main navigation and task board simple.
6. Seamlessly upgrade existing Paperclip users to the new model without forcing disruptive reconfiguration.
7. Support cloud-hosted Paperclip deployments where execution happens in remote or adapter-managed environments rather than local workers.

## Non-Goals

- Turning Paperclip into a full code review product
- Requiring every issue to have its own branch or PR
- Requiring every project to configure code/workspace automation
- Making workspaces a top-level global navigation primitive in V1
- Requiring a local filesystem path or local git checkout to use workspace-aware execution

## Core Product Decisions

### 1. Project stays the planning object

A `project` remains the thing that groups work around a deliverable or initiative.

It may have:

- no code at all
- one default codebase/workspace
- several codebases/workspaces

Projects are not required to become heavyweight.

### 2. Project workspace is a first-class object, but scoped under project

A `project workspace` is the durable codebase or root environment for a project.

Examples:

- a local folder on disk
- a git repo checkout
- a monorepo package root
- a non-git design/doc folder
- a remote adapter-managed codebase reference

This is the stable anchor that operators configure once.

It should not be a top-level sidebar item in the main app. It should live under the project experience.

### 3. Execution workspace is a first-class runtime object

An `execution workspace` is where a specific run or issue actually executes.

Examples:

- the shared project workspace itself
- an isolated git worktree
- a long-lived operator branch checkout
- an adapter-managed remote sandbox
- a cloud agent provider's isolated branch/session environment

This object must be recorded explicitly so that Paperclip can:

- show where work happened
- attach previews and runtime services
- link PRs and branches
- decide cleanup behavior
- support reuse across multiple related issues

### 4. PRs are work product, not the core issue model

A PR is an output of work, not the planning unit.

Paperclip should treat PRs as a type of work product linked back to:

- the issue
- the execution workspace
- optionally the project workspace

Git-specific automation should live under workspace policy, not under the core issue abstraction.

### 5. Existing users must upgrade automatically

Paperclip already has users and existing project/task data. Any new model must preserve continuity.

The product should default existing installs into a sensible compatibility mode:

- existing projects without workspace configuration continue to work unchanged
- existing `project_workspaces` become the durable `project workspace` objects
- existing project execution workspace policy is mapped forward rather than discarded
- issues without explicit workspace fields continue to inherit current behavior

This migration should feel additive, not like a mandatory re-onboarding flow.

### 6. Cloud-hosted Paperclip must be a first-class deployment mode

Paperclip cannot assume that it is running on the same machine as the code.

In cloud deployments, Paperclip may:

- run on Vercel or another serverless host
- have no long-lived local worker process
- delegate execution to a remote coding agent or provider-managed sandbox
- receive back a branch, PR, preview URL, or artifact from that remote environment

The model therefore must be portable:

- `project workspace` may be remote-managed, not local
- `execution workspace` may have no local `cwd`
- `runtime services` may be tracked by provider reference and URL rather than a host process
- work product harvesting must handle externally owned previews and PRs

### 7. Subissues remain planning and ownership structure

Subissues are for decomposition and parallel ownership.

They are not the same thing as:

- a branch
- a worktree
- a PR
- a preview

They may correlate with those things, but they should not be overloaded to mean them.

## Terminology

Use these terms consistently in product copy:

- `Project`: planning container
- `Project workspace`: durable configured codebase/root
- `Execution workspace`: actual runtime workspace used for issue execution
- `Isolated issue workspace`: user-facing term for an issue-specific derived workspace
- `Work product`: previews, PRs, branches, commits, artifacts, docs
- `Runtime service`: a process or service Paperclip owns or tracks for a workspace

Use these terms consistently in migration and deployment messaging:

- `Compatible mode`: existing behavior preserved without new workspace automation
- `Adapter-managed workspace`: workspace realized by a remote or cloud execution provider

Avoid teaching users that "workspace" always means "git worktree on my machine".

## Product Object Model

## 1. Project

Existing object. No fundamental change in role.

### Required behavior

- can exist without code/workspace configuration
- can have zero or more project workspaces
- can define execution defaults that new issues inherit

### Proposed fields

- `id`
- `companyId`
- `name`
- `description`
- `status`
- `goalIds`
- `leadAgentId`
- `targetDate`
- `executionWorkspacePolicy`
- `workspaces[]`
- `primaryWorkspace`

## 2. Project Workspace

Durable, configured, project-scoped codebase/root object.

This should evolve from the current `project_workspaces` table into a more explicit product object.

### Motivation

This separates:

- "what codebase/root does this project use?"

from:

- "what temporary execution environment did this issue run in?"

That keeps the model simple for solo users while still supporting advanced automation.
It also lets cloud-hosted Paperclip deployments point at codebases and remotes without pretending the Paperclip host has direct filesystem access.

### Proposed fields

- `id`
- `companyId`
- `projectId`
- `name`
- `sourceType`
  - `local_path`
  - `git_repo`
  - `remote_managed`
  - `non_git_path`
- `cwd`
- `repoUrl`
- `defaultRef`
- `isPrimary`
- `visibility`
  - `default`
  - `advanced`
- `setupCommand`
- `cleanupCommand`
- `metadata`
- `createdAt`
- `updatedAt`

### Notes

- `sourceType=non_git_path` is important so non-git projects are first-class.
- `setupCommand` and `cleanupCommand` should be allowed here for workspace-root bootstrap, even when isolated execution is not used.
- For a monorepo, multiple project workspaces may point at different roots or packages under one repo.
- `sourceType=remote_managed` is important for cloud deployments where the durable codebase is defined by provider/repo metadata rather than a local checkout path.

## 3. Project Execution Workspace Policy

Project-level defaults for how issues execute.

This is the main operator-facing configuration surface.

### Motivation

This lets Paperclip support:

- direct editing in a shared workspace
- isolated workspaces for issue parallelism
- long-lived integration branch workflows
- remote cloud-agent execution that returns a branch or PR

without forcing every issue or agent to expose low-level runtime configuration.

### Proposed fields

- `enabled: boolean`
- `defaultMode`
  - `shared_workspace`
  - `isolated_workspace`
  - `operator_branch`
  - `adapter_default`
- `allowIssueOverride: boolean`
- `defaultProjectWorkspaceId: uuid | null`
- `workspaceStrategy`
  - `type`
    - `project_primary`
    - `git_worktree`
    - `adapter_managed`
  - `baseRef`
  - `branchTemplate`
  - `worktreeParentDir`
  - `provisionCommand`
  - `teardownCommand`
- `branchPolicy`
  - `namingTemplate`
  - `allowReuseExisting`
  - `preferredOperatorBranch`
- `pullRequestPolicy`
  - `mode`
    - `disabled`
    - `manual`
    - `agent_may_open_draft`
    - `approval_required_to_open`
    - `approval_required_to_mark_ready`
  - `baseBranch`
  - `titleTemplate`
  - `bodyTemplate`
- `runtimePolicy`
  - `allowWorkspaceServices`
  - `defaultServicesProfile`
  - `autoHarvestOwnedUrls`
- `cleanupPolicy`
  - `mode`
    - `manual`
    - `when_issue_terminal`
    - `when_pr_closed`
    - `retention_window`
  - `retentionHours`
  - `keepWhilePreviewHealthy`
  - `keepWhileOpenPrExists`

## 4. Issue Workspace Binding

Issue-level selection of execution behavior.

This should remain lightweight in the normal case and only surface richer controls when relevant.

### Motivation

Not every issue in a code project should create a new derived workspace.

Examples:

- a tiny fix can run in the shared workspace
- three related issues may intentionally share one integration branch
- a solo operator may be working directly on `master`

### Proposed fields on `issues`

- `projectWorkspaceId: uuid | null`
- `executionWorkspacePreference`
  - `inherit`
  - `shared_workspace`
  - `isolated_workspace`
  - `operator_branch`
  - `reuse_existing`
- `preferredExecutionWorkspaceId: uuid | null`
- `executionWorkspaceSettings`
  - keep advanced per-issue override fields here

### Rules

- if the project has no workspace automation, these fields may all be null
- if the project has one primary workspace, issue creation should default to it silently
- `reuse_existing` is advanced-only and should target active execution workspaces, not the whole workspace universe
- existing issues without these fields should behave as `inherit` during migration

## 5. Execution Workspace

A durable record for a shared or derived runtime workspace.

This is the missing object that makes cleanup, previews, PRs, and branch reuse tractable.

### Motivation

Without an explicit `execution workspace` record, Paperclip has nowhere stable to attach:

- derived branch/worktree identity
- active preview ownership
- PR linkage
- cleanup state
- "reuse this existing integration branch" behavior
- remote provider session identity

### Proposed new object

`execution_workspaces`

### Proposed fields

- `id`
- `companyId`
- `projectId`
- `projectWorkspaceId`
- `sourceIssueId`
- `mode`
  - `shared_workspace`
  - `isolated_workspace`
  - `operator_branch`
  - `adapter_managed`
- `strategyType`
  - `project_primary`
  - `git_worktree`
  - `adapter_managed`
- `name`
- `status`
  - `active`
  - `idle`
  - `in_review`
  - `archived`
  - `cleanup_failed`
- `cwd`
- `repoUrl`
- `baseRef`
- `branchName`
- `providerRef`
- `providerType`
  - `local_fs`
  - `git_worktree`
  - `adapter_managed`
  - `cloud_sandbox`
- `derivedFromExecutionWorkspaceId`
- `lastUsedAt`
- `openedAt`
- `closedAt`
- `cleanupEligibleAt`
- `cleanupReason`
- `metadata`
- `createdAt`
- `updatedAt`

### Notes

- `sourceIssueId` is the issue that originally caused the workspace to be created, not necessarily the only issue linked to it later.
- multiple issues may link to the same execution workspace in a long-lived branch workflow.
- `cwd` may be null for remote execution workspaces; provider identity and work product links still make the object useful.

## 6. Issue-to-Execution Workspace Link

An issue may need to link to one or more execution workspaces over time.

Examples:

- an issue begins in a shared workspace and later moves to an isolated one
- a failed attempt is archived and a new workspace is created
- several issues intentionally share one operator branch workspace

### Proposed object

`issue_execution_workspaces`

### Proposed fields

- `issueId`
- `executionWorkspaceId`
- `relationType`
  - `current`
  - `historical`
  - `preferred`
- `createdAt`
- `updatedAt`

### UI simplification

Most issues should only show one current workspace in the main UI. Historical links belong in advanced/history views.

## 7. Work Product

User-facing umbrella concept for outputs of work.

### Motivation

Paperclip needs a single place to show:

- "here is the preview"
- "here is the PR"
- "here is the branch"
- "here is the commit"
- "here is the artifact/report/doc"

without turning issues into a raw dump of adapter details.

### Proposed new object

`issue_work_products`

### Proposed fields

- `id`
- `companyId`
- `projectId`
- `issueId`
- `executionWorkspaceId`
- `runtimeServiceId`
- `type`
  - `preview_url`
  - `runtime_service`
  - `pull_request`
  - `branch`
  - `commit`
  - `artifact`
  - `document`
- `provider`
  - `paperclip`
  - `github`
  - `gitlab`
  - `vercel`
  - `netlify`
  - `custom`
- `externalId`
- `title`
- `url`
- `status`
  - `active`
  - `ready_for_review`
  - `merged`
  - `closed`
  - `failed`
  - `archived`
- `reviewState`
  - `none`
  - `needs_board_review`
  - `approved`
  - `changes_requested`
- `isPrimary`
- `healthStatus`
  - `unknown`
  - `healthy`
  - `unhealthy`
- `summary`
- `metadata`
- `createdByRunId`
- `createdAt`
- `updatedAt`

### Behavior

- PRs are stored here as `type=pull_request`
- previews are stored here as `type=preview_url` or `runtime_service`
- Paperclip-owned processes should update health/status automatically
- external providers should at least store link, provider, external id, and latest known state
- cloud agents should be able to create work product records without Paperclip owning the execution host

## Page and UI Model

## 1. Global Navigation

Do not add `Workspaces` as a top-level sidebar item in V1.

### Motivation

That would make the whole product feel infra-heavy, even for companies that do not use code automation.

### Global nav remains

- Dashboard
- Inbox
- Companies
- Agents
- Goals
- Projects
- Issues
- Approvals

Workspaces and work product should be surfaced through project and issue detail views.

## 2. Project Detail

Add a project sub-navigation that keeps planning first and code second.

### Tabs

- `Overview`
- `Issues`
- `Code`
- `Activity`

Optional future:

- `Outputs`

### `Overview` tab

Planning-first summary:

- project status
- goals
- lead
- issue counts
- top-level progress
- latest major work product summaries

### `Issues` tab

- default to top-level issues only
- show parent issue rollups:
  - child count
  - `x/y` done
  - active preview/PR badges
- optional toggle: `Show subissues`

### `Code` tab

This is the main workspace configuration and visibility surface.

#### Section: `Project Workspaces`

List durable project workspaces for the project.

Card/list columns:

- workspace name
- source type
- path or repo
- default ref
- primary/default badge
- active execution workspaces count
- active issue count
- active preview count
- hosting type / provider when remote-managed

Actions:

- `Add workspace`
- `Edit`
- `Set default`
- `Archive`

#### Section: `Execution Defaults`

Fields:

- `Enable workspace automation`
- `Default issue execution mode`
  - `Shared workspace`
  - `Isolated workspace`
  - `Operator branch`
  - `Adapter default`
- `Default codebase`
- `Allow issue override`

#### Section: `Provisioning`

Fields:

- `Setup command`
- `Cleanup command`
- `Implementation`
  - `Shared workspace`
  - `Git worktree`
  - `Adapter-managed`
- `Base ref`
- `Branch naming template`
- `Derived workspace parent directory`

Hide git-specific fields when the selected workspace is not git-backed.
Hide local-path-specific fields when the selected workspace is remote-managed.

#### Section: `Pull Requests`

Fields:

- `PR workflow`
  - `Disabled`
  - `Manual`
  - `Agent may open draft PR`
  - `Approval required to open PR`
  - `Approval required to mark ready`
- `Default base branch`
- `PR title template`
- `PR body template`

#### Section: `Previews and Runtime`

Fields:

- `Allow workspace runtime services`
- `Default services profile`
- `Harvest owned preview URLs`
- `Track external preview URLs`

#### Section: `Cleanup`

Fields:

- `Cleanup mode`
  - `Manual`
  - `When issue is terminal`
  - `When PR closes`
  - `After retention window`
- `Retention window`
- `Keep while preview is active`
- `Keep while PR is open`

## 3. Add Project Workspace Flow

Entry point: `Project > Code > Add workspace`

### Form fields

- `Name`
- `Source type`
  - `Local folder`
  - `Git repo`
  - `Non-git folder`
  - `Remote managed`
- `Local path`
- `Repository URL`
- `Remote provider`
- `Remote workspace reference`
- `Default ref`
- `Set as default workspace`
- `Setup command`
- `Cleanup command`

### Behavior

- if source type is non-git, hide branch/PR-specific setup
- if source type is git, show ref and optional advanced branch fields
- if source type is remote-managed, show provider/reference fields and hide local-path-only configuration
- for simple solo users, this can be one path field and one save button

## 4. Issue Create Flow

Issue creation should stay simple by default.

### Default behavior

If the selected project:

- has no workspace automation: show no workspace UI
- has one default project workspace and default execution mode: inherit silently

### Show a `Workspace` section only when relevant

#### Basic fields

- `Codebase`
  - default selected project workspace
- `Execution mode`
  - `Project default`
  - `Shared workspace`
  - `Isolated workspace`
  - `Operator branch`

#### Advanced-only field

- `Reuse existing execution workspace`

This dropdown should show only active execution workspaces for the selected project workspace, with labels like:

- `dotta/integration-branch`
- `PAP-447-add-worktree-support`
- `shared primary workspace`

### Important rule

Do not show a picker containing every possible workspace object by default.

The normal flow should feel like:

- choose project
- optionally choose codebase
- optionally choose execution mode

not:

- choose from a long mixed list of roots, derived worktrees, previews, and branch names

### Migration rule

For existing users, issue creation should continue to look the same until a project explicitly enables richer workspace behavior.

## 5. Issue Detail

Issue detail should expose workspace and work product clearly, but without becoming a code host UI.

### Header chips

Show compact summary chips near the title/status area:

- `Codebase: Web App`
- `Workspace: Shared`
- `Workspace: PAP-447-add-worktree-support`
- `PR: Open`
- `Preview: Healthy`

### Tabs

- `Comments`
- `Subissues`
- `Work Product`
- `Activity`

### `Work Product` tab

Sections:

- `Current workspace`
- `Previews`
- `Pull requests`
- `Branches and commits`
- `Artifacts and documents`

#### Current workspace panel

Fields:

- workspace name
- mode
- branch
- base ref
- last used
- linked issues count
- cleanup status

Actions:

- `Open workspace details`
- `Mark in review`
- `Request cleanup`

#### Pull request cards

Fields:

- title
- provider
- status
- review state
- linked branch
- open/ready/merged timestamps

Actions:

- `Open PR`
- `Refresh status`
- `Request board review`

#### Preview cards

Fields:

- title
- URL
- provider
- health
- ownership
- updated at

Actions:

- `Open preview`
- `Refresh`
- `Archive`

## 6. Execution Workspace Detail

This can be reached from a project code tab or an issue work product tab.

It does not need to be in the main sidebar.

### Sections

- identity
- source issue
- linked issues
- branch/ref
- provider/session identity
- active runtime services
- previews
- PRs
- cleanup state
- event/activity history

### Motivation

This is where advanced users go when they need to inspect the mechanics. Most users should not need it in normal flow.

## 7. Inbox Behavior

Inbox should surface actionable work product events, not every implementation detail.

### Show inbox items for

- issue assigned or updated
- PR needs board review
- PR opened or marked ready
- preview unhealthy
- workspace cleanup failed
- runtime service failed
- remote cloud-agent run returned PR or preview that needs review

### Do not show by default

- every workspace heartbeat
- every branch update
- every derived workspace creation

### Display style

If the inbox item is about a preview or PR, show issue context with it:

- issue identifier and title
- parent issue if this is a subissue
- workspace name if relevant

## 8. Issues List and Kanban

Keep list and board planning-first.

### Default behavior

- show top-level issues by default
- show parent rollups for subissues
- do not flatten every child execution detail into the main board

### Row/card adornments

For issues with linked work product, show compact badges:

- `1 PR`
- `2 previews`
- `shared workspace`
- `isolated workspace`

### Optional advanced filters

- `Has PR`
- `Has preview`
- `Workspace mode`
- `Codebase`

## Upgrade and Migration Plan

## 1. Product-level migration stance

Migration must be silent-by-default and compatibility-preserving.

Existing users should not be forced to:

- create new workspace objects by hand before they can keep working
- re-tag old issues
- learn new workspace concepts before basic issue flows continue to function

## 2. Existing project migration

On upgrade:

- existing `project_workspaces` records are retained and shown as `Project Workspaces`
- the current primary workspace remains the default codebase
- existing project execution workspace policy is mapped into the new `Project Execution Workspace Policy` surface
- projects with no execution workspace policy stay in compatible/shared mode

## 3. Existing issue migration

On upgrade:

- existing issues default to `executionWorkspacePreference=inherit`
- if an issue already has execution workspace settings, map them forward directly
- if an issue has no explicit workspace data, preserve existing behavior and do not force a user-visible choice

## 4. Existing run/runtime migration

On upgrade:

- active or recent runtime services can be backfilled into execution workspace history where feasible
- missing history should not block rollout; forward correctness matters more than perfect historical reconstruction

## 5. Rollout UX

Use additive language in the UI:

- `Code`
- `Workspace automation`
- `Optional`
- `Advanced`

Avoid migration copy that implies users were previously using the product "wrong".

## Cloud Deployment Requirements

## 1. Paperclip host and execution host must be decoupled

Paperclip may run:

- locally with direct filesystem access
- in a cloud app host such as Vercel
- in a hybrid setup with external job runners

The workspace model must work in all three.

## 2. Remote execution must support first-class work product reporting

A cloud agent should be able to:

- resolve a project workspace
- realize an adapter-managed execution workspace remotely
- produce a branch
- open or update a PR
- emit preview URLs
- register artifacts

without the Paperclip host itself running local git or local preview processes.

## 3. Local-only assumptions must be optional

The following must be optional, not required:

- local `cwd`
- local git CLI
- host-managed worktree directories
- host-owned long-lived preview processes

## 4. Same product surface, different provider behavior

The UI should not split into "local mode" and "cloud mode" products.

Instead:

- local projects show path/git implementation details
- cloud projects show provider/reference details
- both surface the same high-level objects:
  - project workspace
  - execution workspace
  - work product
  - runtime service or preview

## Patterns Learned from Worktrunk

Worktrunk is a useful reference point because it is unapologetically focused on git-worktree-based developer workflows.

Paperclip should not copy its product framing wholesale, but there are several good patterns worth applying.

References:

- `https://worktrunk.dev/tips-patterns/`
- `https://github.com/max-sixty/worktrunk`

## 1. Deterministic per-workspace resources

Worktrunk treats a derived workspace as something that can deterministically own:

- ports
- local URLs
- databases
- runtime process identity

This is a strong pattern for Paperclip.

### Recommendation

Execution workspaces should be able to deterministically derive and expose:

- preview URLs
- port allocations
- database/schema names
- runtime service reuse keys

This makes previews and local runtime services more predictable and easier to manage across many parallel workspaces.

## 2. Lifecycle hooks should stay simple and explicit

Worktrunk uses practical lifecycle hooks such as create/start/remove/merge-oriented commands.

The main lesson is not to build a huge workflow engine. The lesson is to give users a few well-defined lifecycle moments to attach automation to.

### Recommendation

Paperclip should keep workspace automation centered on a small set of hooks:

- `setup`
- `cleanup`
- optionally `before_review`
- optionally `after_merge` or `after_close`

These should remain project/workspace policy concerns, not agent-prompt conventions.

## 3. Workspace status visibility is a real product feature

Worktrunk's listing/status experience is doing important product work:

- which workspaces exist
- what branch they are on
- what services or URLs they own
- whether they are active or stale

### Recommendation

Paperclip should provide the equivalent visibility in the project `Code` surface:

- active execution workspaces
- linked issues
- linked PRs
- linked previews/runtime services
- cleanup eligibility

This reinforces why `execution workspace` needs to be a first-class recorded object.

## 4. Execution workspaces are runtime islands, not just checkouts

One of Worktrunk's strongest implicit ideas is that a worktree is not only code. It often owns an entire local runtime environment.

### Recommendation

Paperclip should treat execution workspaces as the natural home for:

- dev servers
- preview processes
- sandbox credentials or provider references
- branch/ref identity
- local or remote environment bootstrap

This supports the `work product` model and the preview/runtime service model proposed above.

## 5. Machine-readable workspace state matters

Worktrunk exposes structured state that can be consumed by tools and automation.

### Recommendation

Paperclip should ensure that execution workspaces and work product have clean structured API surfaces, not just UI-only representation.

That is important for:

- agents
- CLIs
- dashboards
- future automation and cleanup tooling

## 6. Cleanup should be first-class, not an afterthought

Worktrunk makes create/remove/merge cleanup part of the workflow.

### Recommendation

Paperclip should continue treating cleanup policy as part of the core workspace model:

- when is cleanup allowed
- what blocks cleanup
- what gets archived versus destroyed
- what happens when cleanup fails

This validates the explicit cleanup policy proposed earlier in this plan.

## 7. What not to copy

There are also important limits to the analogy.

Paperclip should not adopt these Worktrunk assumptions as universal product rules:

- every execution workspace is a local git worktree
- the Paperclip host has direct shell and filesystem access
- every workflow is merge-centric
- every user wants developer-tool-level workspace detail in the main navigation

### Product implication

Paperclip should borrow Worktrunk's good execution patterns while keeping the broader Paperclip model:

- project plans the work
- workspace defines where work happens
- work product defines what came out
- git worktree remains one implementation strategy, not the product itself

## Behavior Rules

## 1. Cleanup must not depend on agents remembering `in_review`

Agents may still use `in_review`, but cleanup behavior must be governed by policy and observed state.

### Keep an execution workspace alive while any of these are true

- a linked issue is non-terminal
- a linked PR is open
- a linked preview/runtime service is active
- the workspace is still within retention window

### Hide instead of deleting aggressively

Archived or idle workspaces should be hidden from default lists before they are hard-cleaned up.

## 2. Multiple issues may intentionally share one execution workspace

This is how Paperclip supports:

- solo dev on a shared branch
- operator integration branches
- related features batched into one PR

This is the key reason not to force 1 issue = 1 workspace = 1 PR.

## 3. Isolated issue workspaces remain opt-in

Even in a git-heavy project, isolated workspaces should be optional.

Examples where shared mode is valid:

- tiny bug fixes
- branchless prototyping
- non-git projects
- single-user local workflows

## 4. PR policy belongs to git-backed workspace policy

PR automation decisions should be made at the project/workspace policy layer.

The issue should only:

- surface the resulting PR
- route approvals/review requests
- show status and review state

## 5. Work product is the user-facing unifier

Previews, PRs, commits, and artifacts should all be discoverable through one consistent issue-level affordance.

That keeps Paperclip focused on coordination and visibility instead of splitting outputs across many hidden subsystems.

## Recommended Implementation Order

## Phase 1: Clarify current objects in UI

1. Surface `Project > Code` tab
2. Show existing project workspaces there
3. Re-enable project-level execution workspace policy with revised copy
4. Keep issue creation simple with inherited defaults

## Phase 2: Add explicit execution workspace record

1. Add `execution_workspaces`
2. Link runs, issues, previews, and PRs to it
3. Add simple execution workspace detail page
4. Make `cwd` optional and ensure provider-managed remote workspaces are supported from day one

## Phase 3: Add work product model

1. Add `issue_work_products`
2. Ingest PRs, previews, branches, commits
3. Add issue `Work Product` tab
4. Add inbox items for actionable work product state changes
5. Support remote agent-created PR/preview reporting without local ownership

## Phase 4: Add advanced reuse and cleanup workflows

1. Add `reuse existing execution workspace`
2. Add cleanup lifecycle UI
3. Add operator branch workflow shortcuts
4. Add richer external preview harvesting
5. Add migration tooling/backfill where it improves continuity for existing users

## Why This Model Is Right

This model keeps the product balanced:

- simple enough for solo users
- strong enough for real engineering teams
- flexible for non-git projects
- explicit enough to govern PRs and previews

Most importantly, it keeps the abstractions clean:

- projects plan the work
- project workspaces define the durable codebases
- execution workspaces define where work ran
- work product defines what came out of the work
- PRs remain outputs, not the core task model

It also keeps the rollout practical:

- existing users can upgrade without workflow breakage
- local-first installs stay simple
- cloud-hosted Paperclip deployments remain first-class

That is a better fit for Paperclip than either extreme:

- hiding workspace behavior until nobody understands it
- or making the whole app revolve around code-host mechanics
