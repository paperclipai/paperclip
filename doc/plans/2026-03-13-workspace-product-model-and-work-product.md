# 工作区产品模型、工作成果与 PR 流程

## 背景

Paperclip 需要支持两种截然不同但同样合理的工作方式：

- 独立开发者直接在 `master` 上工作，或在一个甚至不是 git 仓库的文件夹中工作
- 具有隔离分支、预览、Pull Request 及清理自动化的大型工程工作流

目前，Paperclip 已具备该模型的雏形：

- `projects` 可携带执行工作区策略
- `project_workspaces` 已作为持久化项目级对象存在
- issue 可携带执行工作区设置
- 运行时服务可附加到工作区或 issue

缺少的是清晰的产品模型和 UI，使这些能力易于理解和操作。

主要的产品风险在于将一个概念过载以承担过多职责：

- 让子 issue 承担分支或 PR 的职责
- 让项目变得过于基础设施繁重
- 让工作区过于隐蔽，导致用户无法形成心智模型
- 让 Paperclip 看起来像代码审查工具，而非控制平面

## 目标

1. 保持 `project` 足够轻量，以继续作为规划容器。
2. 使工作区行为对 git 和非 git 项目都易于理解。
3. 支持三种真实工作流，而不强制使用某一种：
   - 共享工作区 / 直接编辑工作流
   - 隔离 issue 工作区工作流
   - 长期存在的分支或运营者集成工作流
4. 提供一个一等公民的位置来查看工作成果：
   - 预览
   - PR
   - 分支
   - 提交
   - 文档和制品
5. 保持主导航和任务看板简洁。
6. 无缝升级现有 Paperclip 用户到新模型，无需强制进行破坏性重新配置。
7. 支持云托管的 Paperclip 部署，其中执行发生在远程或适配器管理的环境中，而非本地工作节点。

## 非目标

- 将 Paperclip 变成完整的代码审查产品
- 要求每个 issue 都有自己的分支或 PR
- 要求每个项目都配置代码/工作区自动化
- 在 V1 中将工作区作为顶级全局导航元素
- 要求使用本地文件系统路径或本地 git 检出来使用工作区感知执行

## 核心产品决策

### 1. 项目保持为规划对象

`project` 继续作为围绕可交付成果或计划将工作分组的对象。

它可以有：

- 完全没有代码
- 一个默认代码库/工作区
- 多个代码库/工作区

项目不需要变得繁重。

### 2. 项目工作区是一等公民对象，但作用域在项目下

`project workspace`（项目工作区）是项目的持久化代码库或根环境。

示例：

- 磁盘上的本地文件夹
- git 仓库检出
- monorepo 包根目录
- 非 git 的设计/文档文件夹
- 远程适配器管理的代码库引用

这是运营者一次性配置的稳定锚点。

它不应该作为主应用中的顶级侧边栏项目，而应位于项目体验之下。

### 3. 执行工作区是一等公民运行时对象

`execution workspace`（执行工作区）是特定运行或 issue 实际执行的地方。

示例：

- 共享的项目工作区本身
- 隔离的 git worktree
- 长期存在的运营者分支检出
- 适配器管理的远程沙箱
- 云代理提供商的隔离分支/会话环境

该对象必须被明确记录，以便 Paperclip 能够：

- 显示工作发生的位置
- 附加预览和运行时服务
- 链接 PR 和分支
- 决定清理行为
- 支持跨多个相关 issue 的复用

### 4. PR 是工作成果，而非核心 issue 模型

PR 是工作的输出，而非规划单元。

Paperclip 应将 PR 视为一种工作成果，并链接回：

- issue
- 执行工作区
- 可选地链接到项目工作区

特定于 git 的自动化应位于工作区策略下，而非核心 issue 抽象之下。

### 5. 现有用户必须自动升级

Paperclip 已有用户和现有项目/任务数据。任何新模型都必须保持连续性。

产品应将现有安装默认置于合理的兼容模式：

- 没有工作区配置的现有项目继续无变化地工作
- 现有 `project_workspaces` 成为持久化的 `project workspace` 对象
- 现有项目执行工作区策略被映射到新版本，而非丢弃
- 没有明确工作区字段的 issue 继续继承当前行为

此迁移应感觉是附加性的，而非强制性的重新入驻流程。

### 6. 云托管的 Paperclip 必须是一等公民部署模式

Paperclip 不能假设它与代码运行在同一台机器上。

在云部署中，Paperclip 可能：

- 在 Vercel 或其他无服务器主机上运行
- 没有长期存在的本地工作节点进程
- 将执行委托给远程编码代理或提供商管理的沙箱
- 从该远程环境接收回分支、PR、预览 URL 或制品

因此模型必须是可移植的：

- `project workspace` 可能是远程管理的，而非本地的
- `execution workspace` 可能没有本地 `cwd`
- `runtime services` 可能通过提供商引用和 URL 来跟踪，而非主机进程
- 工作成果收集必须处理外部拥有的预览和 PR

### 7. 子 issue 保持为规划和所有权结构

子 issue 用于分解和并行所有权。

它们与以下概念不同：

- 分支
- worktree
- PR
- 预览

它们可能与这些概念相关，但不应被过载为意味着它们。

## 术语

在产品文案中一致使用以下术语：

- `Project`：规划容器
- `Project workspace`：持久化配置的代码库/根目录
- `Execution workspace`：用于 issue 执行的实际运行时工作区
- `Isolated issue workspace`：面向用户的术语，指特定 issue 的派生工作区
- `Work product`：预览、PR、分支、提交、制品、文档
- `Runtime service`：Paperclip 为工作区拥有或跟踪的进程或服务

在迁移和部署消息中一致使用以下术语：

- `Compatible mode`：在没有新工作区自动化的情况下保留现有行为
- `Adapter-managed workspace`：由远程或云执行提供商实现的工作区

避免让用户认为"工作区"总是意味着"我机器上的 git worktree"。

## 产品对象模型

## 1. 项目（Project）

现有对象。角色无根本变化。

### 必要行为

- 可以在没有代码/工作区配置的情况下存在
- 可以有零个或多个项目工作区
- 可以定义新 issue 继承的执行默认值

### 提议字段

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

## 2. 项目工作区（Project Workspace）

持久化的、已配置的、项目范围的代码库/根目录对象。

这应该从当前的 `project_workspaces` 表演变为更明确的产品对象。

### 动机

这将以下两个概念分离：

- "该项目使用哪个代码库/根目录？"

与：

- "此 issue 在哪个临时执行环境中运行？"

这使模型对独立用户保持简单，同时仍支持高级自动化。
它还允许云托管的 Paperclip 部署指向代码库和远程端，而无需假装 Paperclip 主机具有直接文件系统访问权限。

### 提议字段

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

### 说明

- `sourceType=non_git_path` 很重要，使非 git 项目成为一等公民。
- `setupCommand` 和 `cleanupCommand` 应在此处允许用于工作区根目录的引导，即使未使用隔离执行。
- 对于 monorepo，多个项目工作区可以指向同一仓库下的不同根目录或包。
- `sourceType=remote_managed` 对于云部署很重要，其中持久化代码库由提供商/仓库元数据定义，而非本地检出路径。

## 3. 项目执行工作区策略（Project Execution Workspace Policy）

issue 如何执行的项目级默认值。

这是面向运营者的主要配置界面。

### 动机

这使 Paperclip 能够支持：

- 在共享工作区中直接编辑
- 用于 issue 并行性的隔离工作区
- 长期存在的集成分支工作流
- 返回分支或 PR 的远程云代理执行

而无需强制每个 issue 或代理暴露低级运行时配置。

### 提议字段

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

## 4. Issue 工作区绑定（Issue Workspace Binding）

issue 级别的执行行为选择。

在正常情况下应保持轻量，仅在相关时才呈现更丰富的控件。

### 动机

代码项目中并非每个 issue 都应创建新的派生工作区。

示例：

- 微小修复可以在共享工作区中运行
- 三个相关 issue 可以有意共享一个集成分支
- 独立运营者可能直接在 `master` 上工作

### `issues` 上的提议字段

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
