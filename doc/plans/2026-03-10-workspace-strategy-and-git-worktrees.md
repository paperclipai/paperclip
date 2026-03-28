# 工作区策略与 Git Worktrees

## 背景

`PAP-447` 探讨 Paperclip 应如何在不将其作为通用产品要求的前提下，为本地编码代理支持基于 worktree 的编码工作流。

该动机用例十分充分：

- 当一个问题开始时，本地编码代理可能需要自己的独立检出（isolated checkout）
- 代理可能需要一个专用分支，以及之后推送的可预测路径
- 代理可能需要启动一个或多个长期运行的工作区运行时服务，发现可达的端口或 URL，并将其报告回该问题
- 该工作流应复用同一个 Paperclip 实例和嵌入式数据库，而不是创建一个空白环境
- 本地代理的身份验证应保持低摩擦

与此同时，我们不希望将"每个代理都使用 git worktrees"硬编码到 Paperclip 中：

- 部分运营者使用 Paperclip 来管理 Paperclip 本身，并大量依赖 worktrees
- 其他运营者完全不需要 worktrees
- 并非每个适配器都在本地 git 仓库中运行
- 并非每个适配器都与 Paperclip 运行在同一台机器上
- Claude 和 Codex 暴露了不同的内置功能，因此 Paperclip 不应过度适配某一工具

## 核心产品决策

Paperclip 应建模**执行工作区（execution workspaces）**，而非 **worktrees**。

更具体地说：

- 持久锚点是**项目工作区（project workspace）**或仓库检出
- 一个问题可以从该项目工作区派生出一个临时的**执行工作区（execution workspace）**
- 执行工作区的一种实现方式是 **git worktree**
- 适配器决定是否以及如何使用该派生工作区

这保持了抽象的可移植性：

- `project workspace` 是仓库/项目层面的概念
- `execution workspace` 是一次运行时的运行时检出/cwd
- `git worktree` 是创建该执行工作区的一种策略
- `workspace runtime services` 是附属于该工作区的长期运行进程或预览

这也使抽象对非本地适配器保持有效：

- 本地适配器可以接收 Paperclip 生成的真实文件系统 cwd
- 远程或云适配器可以以结构化形式接收相同的执行意图，并在其自己的环境中实现
- Paperclip 不应假设每个适配器都能看到或直接使用宿主文件系统路径

## 主要框架问题的解答

### Worktrees 是用于代理的还是用于仓库/项目的？

它们应被视为**仓库/项目范围的基础设施**，而非代理身份的一部分。

稳定的对象是项目工作区。代理来来去去，所有权会发生变化，同一个问题也可能被重新分配。git worktree 是针对特定任务或问题从仓库工作区派生的检出。代理使用它，但不应拥有该抽象。

如果 Paperclip 将 worktrees 以代理为先，将会混淆：

- 代理主目录
- 项目仓库根目录
- 问题特定的分支/检出

这会使复用、重新分配、清理和 UI 可见性变得更加困难。

### 我们如何保持灵活性？

通过使执行工作区策略**在适配器/配置层面选择性启用**，而非作为全局不变量。

默认值应保持：

- 现有的项目工作区解析
- 现有的任务会话恢复
- 现有的代理主目录回退

然后本地编码代理可以选择加入 `git_worktree` 这样的策略。

### 我们如何使其可移植且适配器友好？

通过拆分职责：

- Paperclip 核心解析并记录执行工作区状态
- 共享的本地运行时助手可以实现基于 git 的检出策略
- 每个适配器使用适配器特定的标志在解析后的 cwd 内启动其工具

这避免了将 Claude 形态或 Codex 形态的模型强加给所有适配器。

这也避免了将宿主文件系统模型强加给云代理。云适配器可以将相同的请求策略解释为：

- 从 repo + ref 创建一个全新的沙盒检出
- 在提供商的远程环境中创建一个隔离的分支/工作区
- 忽略宿主 cwd 等仅限本地的字段，同时仍遵循分支/ref/隔离意图

## 产品与用户体验要求

当前的技术模型方向正确，但产品界面需要在以下概念之间进行更清晰的分离：

- 跨适配器通用概念**执行工作区（execution workspace）**
- 面向用户的本地 git 实现概念**独立问题检出（isolated issue checkout）**
- 特定 git 实现细节 **git worktree**

这些不应在 UI 中合并为一个标签。

### 术语建议

对于产品/UI 文案：

- 使用**执行工作区（execution workspace）**表示跨适配器的通用概念
- 使用**独立问题检出（isolated issue checkout）**表示面向用户的功能，即"该问题拥有自己的分支/检出"
- 将 **git worktree** 保留用于高级或实现细节视图

这为 Paperclip 提供了支持以下内容的空间：

- 本地 git worktrees
- 远程沙盒检出
- 适配器管理的远程工作区

而无需让用户认为"工作区"总是意味着"我机器上的 git worktree"。

### 项目级默认值应驱动该功能

主要配置位置应在**项目**层面，而非代理表单。

原因：

- 仓库/项目是否需要独立问题检出，主要是项目工作流决策
- 大多数运营者不希望为每个代理配置运行时 JSON
- 除非有强烈的适配器特定覆盖，代理应继承项目的工作区策略
- 看板需要一个地方来表达仓库工作流默认值，例如分支、PR、清理和预览生命周期

因此项目应拥有如下设置：

- `isolatedIssueCheckouts.enabled` 或等效项

这应作为该项目中新问题的默认驱动器。

### 问题级使用应保持可选

即使项目支持独立问题检出，也不应强制每个问题都使用。

示例：

- 小修复可能在主项目工作区中就够用了
- 运营者可能希望直接在长期分支上工作
- 看板用户可能希望创建任务而不需要付出设置/清理的开销

因此模型应为：

- 项目定义独立问题检出是否可用以及默认值是什么
- 每个问题在创建时可以选择加入或退出
- 问题的默认值可以从项目继承

这不应要求在正常问题创建流程中显示高级适配器配置。

### 运行时服务通常应隐藏在代理表单之外

当前原始运行时服务 JSON 对于大多数本地代理来说作为主要 UI 层级过低。

对于 `claude_local` 和 `codex_local`，可能期望的行为是：

- Paperclip 使用项目/工作区策略在后台处理工作区运行时服务
- 运营者不需要在代理表单中手写通用运行时 JSON
- 如果某个提供商特定的适配器将来需要更丰富的运行时配置，提供专用 UI，而非默认使用通用 JSON

因此 UI 建议为：

- 将运行时服务 JSON 排除在默认本地代理编辑体验之外
- 仅在高级部分或适配器特定专家模式后面允许使用
- 将常见工作流设置移至项目级工作区自动化设置

### Pull request 工作流需要明确的所有权和审批规则

一旦 Paperclip 创建独立问题检出，就隐式涉及更大的工作流：

- 分支创建
- 运行时服务启动/停止
- 提交和推送
- PR 创建
- 合并或放弃后的清理

这意味着产品需要一个明确的模型来定义 **PR 创建和合并就绪的所有者**。

至少有两种有效模式：

- 代理管理的 PR 创建
- 审批门控的 PR 创建

以及可能的三个不同决策点：

1. 代理是否应自动提交？
2. 代理是否应自动打开 PR？
3. 打开或标记为就绪是否需要看板审批？

这些不应埋藏在适配器提示中。它们是工作流策略。

### 人工运营者工作流与问题隔离工作流不同

人工运营者可能希望有一个长期个人集成分支（例如 `dotta`），且可能不希望每个任务都创建新的分支/工作区。

这是合理的工作流，应直接支持。

因此 Paperclip 应区分：

- **独立问题检出工作流（isolated issue checkout workflows）**：针对代理并行性和问题范围隔离进行优化
- **个人分支工作流（personal branch workflows）**：针对人工或运营者在长期分支上进行多项相关更改，并在方便时向主分支创建 PR 进行优化

这意味着：

- 即使独立问题检出可用，它也应是可选的
- 项目工作流设置应支持"直接使用基础分支"或"使用首选运营者分支"的路径
- PR 策略不应假设每个工作单元都与新分支或 PR 一一对应

## Recommended UX Model

### 1. Project-level "Execution Workspace" settings

Projects should have a dedicated settings area for workspace automation.

Suggested structure:

- `Execution Workspaces`
  - `Enable isolated issue checkouts`
  - `Default for new issues`
  - `Checkout implementation`
  - `Branch and PR behavior`
  - `Runtime services`
  - `Cleanup behavior`

For a local git-backed project, the visible language can be more concrete:

- `Enable isolated issue checkouts`
- `Implementation: Git worktree`

For remote or adapter-managed projects, the same section can instead say:

- `Implementation: Adapter-managed workspace`

### 2. Issue creation should expose a simple opt-in

When creating an issue inside a project with execution workspace support enabled:

- show a checkbox or toggle such as `Use isolated issue checkout`
- default it from the project setting
- hide advanced workspace controls unless the operator has expanded an advanced section

If the project does not support execution workspaces, do not show the control at all.

This keeps the default UI light while preserving control.

### 3. Agent configuration should be mostly inheritance-based

The agent form should not be the primary place where operators assemble worktree/runtime policy for common local agents.

Instead:

- local coding agents inherit the project's execution workspace policy
- the agent form only exposes an override when truly necessary
- raw JSON config is advanced-only

That means the common case becomes:

- configure the project once
- assign a local coding agent
- create issues with optional isolated checkout behavior

### 4. Advanced implementation detail can still exist

There should still be an advanced view for power users that shows:

- execution workspace strategy payload
- runtime service intent payload
- adapter-specific overrides

But that should be treated like an expert/debugging surface, not the default mental model.

## Recommended Workflow Policy Model

### Workspace realization policy

Suggested policy values:

- `shared_project_workspace`
- `isolated_issue_checkout`
- `adapter_managed_isolated_workspace`

For local git projects, `isolated_issue_checkout` may map to `git_worktree`.

### Branch policy

Suggested project-level branch policy fields:

- `baseBranch`
- `branchMode`: `issue_scoped | operator_branch | project_primary`
- `branchTemplate` for issue-scoped branches
- `operatorPreferredBranch` for human/operator workflows

This allows:

- strict issue branches for agents
- long-lived personal branches for humans
- direct use of the project primary workspace when desired

### Pull request policy

Suggested project-level PR policy fields:

- `prMode`: `none | agent_may_open | agent_auto_open | approval_required`
- `autoPushOnDone`: boolean
- `requireApprovalBeforeOpen`: boolean
- `requireApprovalBeforeReady`: boolean
- `defaultBaseBranch`

This keeps PR behavior explicit and governable.

### Cleanup policy

Suggested project-level cleanup fields:

- `stopRuntimeServicesOnDone`
- `removeIsolatedCheckoutOnDone`
- `removeIsolatedCheckoutOnMerged`
- `deleteIssueBranchOnMerged`
- `retainFailedWorkspaceForInspection`

These matter because workspace automation is not just setup. The cleanup path is part of the product.

## Design Recommendations for the Current UI Problem

Based on the concerns above, the UI should change in these ways:

### Agent UI

- remove generic runtime service JSON from the default local-agent configuration surface
- keep raw workspace/runtime JSON behind advanced settings only
- prefer inheritance from project settings for `claude_local` and `codex_local`
- only add adapter-specific runtime UI when an adapter truly needs settings that Paperclip cannot infer

### Project UI

- add a project-level execution workspace settings section
- allow enabling isolated issue checkouts for that project
- store default issue behavior there
- expose branch, PR, runtime service, and cleanup defaults there

### Issue creation UI

- only show `Use isolated issue checkout` when the project has execution workspace support enabled
- keep it as an issue-level opt-in/out, defaulted from the project
- hide advanced execution workspace details unless requested

## Consequences for the Spec

This changes the emphasis of the plan in a useful way:

- the project becomes the main workflow configuration owner
- the issue becomes the unit of opt-in/out for isolated checkout behavior
- the agent becomes an executor that usually inherits the workflow policy
- raw runtime JSON becomes an advanced/internal representation, not the main UX

It also clarifies that PR creation and cleanup are not optional side notes. They are core parts of the workspace automation product surface.

## Concrete Integration Checklist

This section turns the product requirements above into a concrete implementation plan for the current codebase.

### Guiding precedence rule

The runtime decision order should become:

1. issue-level execution workspace override
2. project-level execution workspace policy
3. agent-level adapter override
4. current default behavior

That is the key architectural change. Today the implementation is too agent-config-centered for the desired UX.

## Proposed Field Names

### Project-level fields

Add a project-owned execution workspace policy object. Suggested shared shape:

```ts
type ProjectExecutionWorkspacePolicy = {
  enabled: boolean;
  defaultMode: "inherit_project_default" | "shared_project_workspace" | "isolated_issue_checkout";
  implementation: "git_worktree" | "adapter_managed";
  branchPolicy: {
    baseBranch: string | null;
    branchMode: "issue_scoped" | "operator_branch" | "project_primary";
    branchTemplate: string | null;
    operatorPreferredBranch: string | null;
  };
  pullRequestPolicy: {
    mode: "none" | "agent_may_open" | "agent_auto_open" | "approval_required";
    autoPushOnDone: boolean;
    requireApprovalBeforeOpen: boolean;
    requireApprovalBeforeReady: boolean;
    defaultBaseBranch: string | null;
  };
  cleanupPolicy: {
    stopRuntimeServicesOnDone: boolean;
    removeExecutionWorkspaceOnDone: boolean;
    removeExecutionWorkspaceOnMerged: boolean;
    deleteIssueBranchOnMerged: boolean;
    retainFailedWorkspaceForInspection: boolean;
  };
  runtimeServices: {
    mode: "disabled" | "project_default";
    services?: Array<Record<string, unknown>>;
  };
};
```

Notes:

- `enabled` controls whether the project exposes isolated issue checkout behavior at all
- `defaultMode` controls issue creation defaults
- `implementation` stays generic enough for local or remote adapters
- runtime service config stays nested here, not in the default agent form

### Issue-level fields

Add issue-owned opt-in/override fields. Suggested shape:

```ts
type IssueExecutionWorkspaceSettings = {
  mode?: "inherit_project_default" | "shared_project_workspace" | "isolated_issue_checkout";
  branchOverride?: string | null;
  pullRequestModeOverride?: "inherit" | "none" | "agent_may_open" | "agent_auto_open" | "approval_required";
};
```

This should usually be hidden behind simple UI:

- a checkbox like `Use isolated issue checkout`
- advanced controls only when needed

### Agent-level fields

Keep agent-level workspace/runtime configuration, but reposition it as advanced override only.

Suggested semantics:

- if absent, inherit project + issue policy
- if present, override only the implementation detail needed for that adapter

## Shared Type and API Changes

### 1. Shared project types

Files to change first:

- `packages/shared/src/types/project.ts`
- `packages/shared/src/validators/project.ts`

Add:

- `executionWorkspacePolicy?: ProjectExecutionWorkspacePolicy | null`

### 2. Shared issue types

Files to change:

- `packages/shared/src/types/issue.ts`
- `packages/shared/src/validators/issue.ts`

Add:

- `executionWorkspaceSettings?: IssueExecutionWorkspaceSettings | null`

### 3. DB schema

If we want these fields persisted directly on existing entities instead of living in opaque JSON:

- `packages/db/src/schema/projects.ts`
- `packages/db/src/schema/issues.ts`
- migration generation in `packages/db/src/migrations/`

Recommended first cut:

- store project policy as JSONB on `projects`
- store issue setting override as JSONB on `issues`

That minimizes schema churn while the product model is still moving.

Suggested columns:

- `projects.execution_workspace_policy jsonb`
- `issues.execution_workspace_settings jsonb`

## Server-Side Resolution Changes

### 4. Project service read/write path

Files:

- `server/src/services/projects.ts`
- project routes in `server/src/routes/projects.ts`

Tasks:

- accept and validate project execution workspace policy
- return it from project API payloads
- enforce company scoping as usual

### 5. Issue service create/update path

Files:

- `server/src/services/issues.ts`
- `server/src/routes/issues.ts`

Tasks:

- accept issue-level `executionWorkspaceSettings`
- when creating an issue in a project with execution workspaces enabled, default the issue setting from the project policy if not explicitly provided
- keep issue payload simple for normal clients; advanced fields may be optional

### 6. Heartbeat and run resolution

Primary file:

- `server/src/services/heartbeat.ts`

Current behavior should be refactored so workspace resolution is based on:

- issue setting
- then project policy
- then adapter override

Specific technical work:

- load project execution workspace policy during run resolution
- load issue execution workspace settings during run resolution
- derive an effective execution workspace decision object before adapter launch
- keep adapter config as override only

Suggested internal helper:

```ts
type EffectiveExecutionWorkspaceDecision = {
  mode: "shared_project_workspace" | "isolated_issue_checkout";
  implementation: "git_worktree" | "adapter_managed" | "project_primary";
  branchPolicy: {...};
  pullRequestPolicy: {...};
  cleanupPolicy: {...};
  runtimeServices: {...};
};
```

## UI Changes

### 7. Project settings UI

Likely files:

- `ui/src/components/ProjectProperties.tsx`
- project detail/settings pages under `ui/src/pages/`
- project API client in `ui/src/api/projects.ts`

Add a project-owned section:

- `Execution Workspaces`
  - enable isolated issue checkouts
  - default for new issues
  - implementation type
  - branch settings
  - PR settings
  - cleanup settings
  - runtime service defaults

Important UX rule:

- runtime service config should not default to raw JSON
- if the first cut must use JSON internally, wrap it in a minimal structured form or advanced disclosure

### 8. Issue creation/edit UI

Likely files:

- issue create UI components and issue detail edit surfaces in `ui/src/pages/`
- issue API client in `ui/src/api/issues.ts`

Add:

- `Use isolated issue checkout` toggle, only when project policy enables it
- advanced workspace behavior controls only when expanded

Do not show:

- raw runtime service JSON
- raw strategy payloads

in the default issue creation flow.

### 9. Agent UI cleanup

Files:

- `ui/src/adapters/local-workspace-runtime-fields.tsx`
- `ui/src/adapters/codex-local/config-fields.tsx`
- `ui/src/adapters/claude-local/config-fields.tsx`

Technical direction:

- keep the existing config surface as advanced override
- remove it from the default form flow for local coding agents
- add explanatory copy that project execution workspace policy is inherited unless overridden

## Adapter and Orchestration Changes

### 10. Local adapter behavior

Files:

- `packages/adapters/codex-local/src/ui/build-config.ts`
- `packages/adapters/claude-local/src/ui/build-config.ts`
- local adapter execute paths already consuming env/context

Tasks:

- continue to accept resolved workspace/runtime context from heartbeat
- stop assuming the agent config is the primary source of workspace policy
- preserve adapter-specific override support

### 11. Runtime service orchestration

Files:

- `server/src/services/workspace-runtime.ts`

Tasks:

- accept runtime service defaults from the effective project/issue policy
- keep adapter-config runtime service JSON as override-only
- preserve portability for remote adapters

## Pull Request and Cleanup Workflow

### 12. PR policy execution

This is not fully implemented today and should be treated as a separate orchestration layer.

Likely files:

- `server/src/services/heartbeat.ts`
- future git/provider integration helpers

Needed decisions:

- when issue moves to done, should Paperclip auto-commit?
- should it auto-push?
- should it auto-open a PR?
- should PR open/ready be approval-gated?

Suggested approach:

- store PR policy on project
- resolve effective PR policy per issue/run
- emit explicit workflow actions rather than relying on prompt text alone

### 13. Cleanup policy execution

Likely files:

- `server/src/services/workspace-runtime.ts`
- `server/src/services/heartbeat.ts`
- any future merge-detection hooks

Needed behaviors:

- stop runtime services on done or merged
- remove isolated checkout on done or merged
- delete branch on merged if policy says so
- optionally retain failed workspace for inspection

## Recommended First Implementation Sequence

To integrate these ideas without destabilizing the system, implement in this order:

1. Add project policy fields to shared types, validators, DB, services, routes, and project UI.
2. Add issue-level execution workspace setting fields to shared types, validators, DB, services, routes, and issue create/edit UI.
3. Refactor heartbeat to compute effective execution workspace policy from issue -> project -> agent override.
4. Change local-agent UI so workspace/runtime JSON becomes advanced-only.
5. Move default runtime service behavior to project settings.
6. Add explicit PR policy storage and resolution.
7. Add explicit cleanup policy storage and resolution.

## Definition of Done for This Product Shift

This design shift is complete when all are true:

- project settings own the default workspace policy
- issue creation exposes a simple opt-in/out when available
- local agent forms no longer require raw runtime JSON for common cases
- heartbeat resolves effective workspace behavior from project + issue + override precedence
- PR and cleanup behavior are modeled as explicit policy, not implied prompt behavior
- the UI language distinguishes execution workspace from local git worktree implementation details

## What the Current Code Already Supports

Paperclip already has the right foundation for a project-first model.

### Project workspace is already first-class

- `project_workspaces` already exists in `packages/db/src/schema/project_workspaces.ts`
- the shared `ProjectWorkspace` type already includes `cwd`, `repoUrl`, and `repoRef` in `packages/shared/src/types/project.ts`
- docs already state that agents use the project's primary workspace for project-scoped tasks in `docs/api/goals-and-projects.md`

### Heartbeat already resolves workspace in the right order

Current run resolution already prefers:

1. project workspace
2. prior task session cwd
3. agent-home fallback

See `server/src/services/heartbeat.ts`.

### Session resume is already cwd-aware

Both local coding adapters treat session continuity as cwd-bound:

- Codex: `packages/adapters/codex-local/src/server/execute.ts`
- Claude: `packages/adapters/claude-local/src/server/execute.ts`

That means the clean insertion point is before adapter execution: resolve the final execution cwd first, then let the adapter run normally.

### Server-spawned local auth already exists

For server-spawned local adapters, Paperclip already injects a short-lived local JWT:

- JWT creation: `server/src/services/heartbeat.ts`
- adapter env injection:
  - `packages/adapters/codex-local/src/server/execute.ts`
  - `packages/adapters/claude-local/src/server/execute.ts`

The manual-local bootstrap path is still weaker in authenticated mode, but that is a related auth ergonomics problem, not a reason to make worktrees a core invariant.

## Tooling Observations from Vendor Docs

The linked tool docs support a project-first, adapter-specific launch model.

### Codex

- Codex app has a native worktree concept for parallel tasks in git repos
- Codex CLI documents running in a chosen working directory and resuming sessions from the current working directory
- Codex CLI does not present a single first-class portable CLI worktree abstraction that Paperclip should mirror directly

Implication:

- for `codex_local`, Paperclip should usually create/select the checkout itself and then launch Codex inside that cwd

### Claude

- Claude documents explicit git worktree workflows for parallel sessions
- Claude CLI supports `--worktree` / `-w`
- Claude sessions also remain tied to directory context

Implication:

- `claude_local` can optionally use native `--worktree`
- but Paperclip should still treat that as an adapter optimization, not the canonical cross-adapter model

## Local vs Remote Adapters

This plan must explicitly account for the fact that many adapters are not local.

Examples:

- local CLI adapters such as `codex_local` and `claude_local`
- cloud-hosted coding agents such as Cursor cloud agents
- future hosted Codex or Claude agent modes
- custom sandbox adapters built on E2B, Cloudflare, or similar environments

These adapters do not all share the same capabilities:

- some can use host git worktrees directly
- some can clone a repo and create branches remotely
- some may expose a virtual workspace concept with no direct git worktree equivalent
- some may not allow persistent filesystem state at all

Because of that, Paperclip should separate:

- **execution workspace intent**: what isolation/branch/repo behavior we want
- **adapter realization**: how a specific adapter implements that behavior

### Execution workspace intent

Paperclip should be able to express intentions such as:

- use the project's primary workspace directly
- create an isolated issue-scoped checkout
- base work on a given repo ref
- derive a branch name from the issue
- expose one or more reachable preview or service URLs if runtime services are started

### Adapter realization

Adapters should be free to map that intent into their own environment:

- local adapter: create a host git worktree and run in that cwd
- cloud sandbox adapter: clone repo into a sandbox, create a branch there, and return sandbox metadata
- hosted remote coding agent: call provider APIs that create a remote workspace/thread bound to the requested branch/ref

The important constraint is that the adapter reports back the realized execution workspace metadata in a normalized shape, even if the underlying implementation is not a git worktree.

## Proposed Model

Use three layers:

1. `project workspace`
2. `execution workspace`
3. `workspace runtime services`
4. `adapter session`

### 1. Project workspace

Long-lived repo anchor.

Examples:

- `./paperclip`
- repo URL and base ref
- primary checkout for a project

### 2. Execution workspace

Derived runtime checkout for a specific issue/run.

Examples:

- direct use of the project primary workspace
- git worktree derived from the project workspace
- remote sandbox checkout derived from repo URL + ref
- custom checkout produced by an adapter-specific script

### 3. Adapter session

Long-lived or semi-long-lived processes associated with a workspace.

Examples:

- local web server
- background worker
- sandbox preview URL
- test watcher
- tunnel process

These are not specific to Paperclip. They are a common property of working in a dev workspace, whether local or remote.

### 4. Adapter session

Claude/Codex conversation continuity and runtime state, which remains cwd-aware and should follow the execution workspace rather than define it.

## Recommended Configuration Surface

Introduce a generic execution workspace strategy in adapter config.

Example shape:

```json
{
  "workspaceStrategy": {
    "type": "project_primary"
  }
}
```

Or:

```json
{
  "workspaceStrategy": {
    "type": "git_worktree",
    "baseRef": "origin/main",
    "branchTemplate": "{{issue.identifier}}-{{slug}}",
    "worktreeParentDir": ".paperclip/instances/default/worktrees/projects/{{project.id}}",
    "cleanupPolicy": "on_merged",
    "startDevServer": true,
    "devServerCommand": "pnpm dev",
    "devServerReadyUrlTemplate": "http://127.0.0.1:{{port}}/api/health"
  }
}
```

Remote adapters may instead use shapes like:

```json
{
  "workspaceStrategy": {
    "type": "isolated_checkout",
    "provider": "adapter_managed",
    "baseRef": "origin/main",
    "branchTemplate": "{{issue.identifier}}-{{slug}}"
  }
}
```

The important point is that `git_worktree` is a strategy value for adapters that can use it, not the universal contract.

### Workspace runtime services

Do not model this as a Paperclip-specific `devServer` flag.

Instead, model it as a generic list of workspace-attached runtime services.

Example shape:

```json
{
  "workspaceRuntime": {
    "services": [
      {
        "name": "web",
        "description": "Primary app server for this workspace",
        "command": "pnpm dev",
        "cwd": ".",
        "env": {
          "DATABASE_URL": "${workspace.env.DATABASE_URL}"
        },
        "port": {
          "type": "auto"
        },
        "readiness": {
          "type": "http",
          "urlTemplate": "http://127.0.0.1:${port}/api/health"
        },
        "expose": {
          "type": "url",
          "urlTemplate": "http://127.0.0.1:${port}"
        },
        "reuseScope": "project_workspace",
        "lifecycle": "shared",
        "stopPolicy": {
          "type": "idle_timeout",
          "idleSeconds": 1800
        }
      }
    ]
  }
}
```

This contract is intentionally generic:

- `command` can start any workspace-attached process, not just a web server
- database reuse is handled through env/config injection, not a product-specific special case
- local and remote adapters can realize the same service intent differently

### Service intent vs service realization

Paperclip should distinguish between:

- **service intent**: what kind of companion runtime the workspace wants
- **service realization**: how a local or remote adapter actually starts and exposes it

Examples:

- local adapter:
  - starts `pnpm dev`
  - allocates a free host port
  - health-checks a localhost URL
  - reports `{ pid, port, url }`
- cloud sandbox adapter:
  - starts a preview process inside the sandbox
  - receives a provider preview URL
  - reports `{ sandboxId, previewUrl }`
- hosted remote coding agent:
  - may ask the provider to create a preview environment
  - reports provider-native workspace/service metadata

Paperclip should normalize the reported metadata without requiring every adapter to look like a host-local process.

Keep issue-level overrides possible through the existing `assigneeAdapterOverrides` shape in `packages/shared/src/types/issue.ts`.

## Responsibilities by Layer

### Paperclip Core

Paperclip core should:

- resolve the base project workspace for the issue
- resolve or request an execution workspace
- resolve or request workspace runtime services when configured
- inject execution workspace metadata into run context
- persist enough metadata for board visibility and cleanup
- manage lifecycle hooks around run start/finish where needed

Paperclip core should not:

- require worktrees for all agents
- assume every adapter is local and git-backed
- assume every runtime service is a localhost process with a PID
- encode tool-specific worktree prompts as core product behavior

### Shared Local Runtime Helper

A shared server-side helper should handle local git mechanics:

- validate repo root
- create/select branch
- create/select git worktree
- allocate a free port
- optionally start and track a dev server
- return `{ cwd, branchName, url }`

This helper can be reused by:

- `codex_local`
- `claude_local`
- future local adapters like Cursor/OpenCode equivalents

This helper is intentionally for local adapters only. Remote adapters should not be forced through a host-local git helper.

### Shared Runtime Service Manager

In addition to the local git helper, Paperclip should define a generic runtime service manager contract.

Its job is to:

- decide whether a configured service should be reused or started fresh
- allocate local ports when needed
- start and monitor local processes when the adapter/runtime realization is host-local
- record normalized service metadata for remote realizations
- run readiness checks
- surface service URLs and state to the board
- apply shutdown policy

This manager should not be hard-coded to "dev servers". It should work for any long-lived workspace companion process.

### Adapter

The adapter should:

- accept the resolved execution cwd
- or accept structured execution workspace intent when no host cwd is available
- accept structured workspace runtime service intent when service orchestration is delegated to the adapter
- launch its tool with adapter-specific flags
- keep its own session continuity semantics

For example:

- `codex_local`: run inside cwd, likely with `--cd` or process cwd
- `claude_local`: run inside cwd, optionally use `--worktree` when it helps
- remote sandbox adapter: create its own isolated workspace from repo/ref/branch intent and report the realized remote workspace metadata back to Paperclip

For runtime services:

- local adapter or shared host manager: start the local process and return host-local metadata
- remote adapter: create or reuse the remote preview/service and return normalized remote metadata

## Minimal Data Model Additions

Do not create a fully first-class `worktrees` table yet.

Start smaller by recording derived execution workspace metadata on runs, issues, or both.

Suggested fields to introduce:

- `executionWorkspaceStrategy`
- `executionWorkspaceCwd`
- `executionBranchName`
- `executionWorkspaceStatus`
- `executionServiceRefs`
- `executionCleanupStatus`

These can live first on `heartbeat_runs.context_snapshot` or adjacent run metadata, with an optional later move into a dedicated table if the UI and cleanup workflows justify it.

For runtime services specifically, Paperclip should eventually track normalized fields such as:

- `serviceName`
- `serviceKind`
- `scopeType`
- `scopeId`
- `status`
- `command`
- `cwd`
- `envFingerprint`
- `port`
- `url`
- `provider`
- `providerRef`
- `startedByRunId`
- `ownerAgentId`
- `lastUsedAt`
- `stopPolicy`
- `healthStatus`

The first implementation can keep this in run metadata if needed, but the long-term shape is a generic runtime service registry rather than one-off server URL fields.

## Concrete Implementation Plan

## Phase 1: Define Shared Contracts

1. Introduce a shared execution workspace strategy contract in `packages/shared`.
2. Add adapter-config schema support for:
   - `workspaceStrategy.type`
   - `baseRef`
   - `branchTemplate`
   - `worktreeParentDir`
   - `cleanupPolicy`
   - optional workspace runtime service settings
3. Keep the existing `useProjectWorkspace` flag working as a lower-level compatibility control.
4. Distinguish local realization fields from generic intent fields so remote adapters are not forced to consume host cwd values.
5. Define a generic `workspaceRuntime.services[]` contract with:
   - service name
   - command or provider-managed intent
   - env overrides
   - readiness checks
   - exposure metadata
   - reuse scope
   - lifecycle
   - stop policy

Acceptance:

- adapter config can express `project_primary` and `git_worktree`
- config remains optional and backwards-compatible
- runtime services are expressed generically, not as Paperclip-only dev-server flags

## Phase 2: Resolve Execution Workspace in Heartbeat

1. Extend heartbeat workspace resolution so it can return a richer execution workspace result.
2. Keep current fallback order, but distinguish:
   - base project workspace
   - derived execution workspace
3. Inject resolved execution workspace details into `context.paperclipWorkspace` for local adapters and into a generic execution-workspace intent payload for adapters that need structured remote realization.
4. Resolve configured runtime service intent alongside the execution workspace so the adapter or host manager receives a complete workspace runtime contract.

Primary touchpoints:

- `server/src/services/heartbeat.ts`

Acceptance:

- runs still work unchanged when no strategy is configured
- the resolved context clearly indicates which strategy produced the cwd

## Phase 3: Add Shared Local Git Workspace Helper

1. Create a server-side helper module for local repo checkout strategies.
2. Implement `git_worktree` strategy:
   - validate git repo at base workspace cwd
   - derive branch name from issue
   - create or reuse a worktree path
   - detect collisions cleanly
3. Return structured metadata:
   - final cwd
   - branch name
   - worktree path
   - repo root

Acceptance:

- helper is reusable outside a single adapter
- worktree creation is deterministic for a given issue/config
- remote adapters remain unaffected by this helper

## Phase 4: Optional Dev Server Lifecycle

Rename this phase conceptually to **workspace runtime service lifecycle**.

1. Add optional runtime service startup on execution workspace creation.
2. Support both:
   - host-managed local services
   - adapter-managed remote services
3. For local services:
   - allocate a free port before launch when required
   - start the configured command in the correct cwd
   - run readiness checks
   - register the realized metadata
4. For remote services:
   - let the adapter return normalized service metadata after provisioning
   - do not assume PID or localhost access
5. Post or update issue-visible metadata with the service URLs and labels.

Acceptance:

- runtime service startup remains opt-in
- failures produce actionable run logs and issue comments
- same embedded DB / Paperclip instance can be reused through env/config injection when appropriate
- remote service realizations are represented without pretending to be local processes

## Phase 5: Runtime Service Reuse, Tracking, and Shutdown

1. Introduce a generic runtime service registry.
2. Each service should be tracked with:
   - `scopeType`: `project_workspace | execution_workspace | run | agent`
   - `scopeId`
   - `serviceName`
   - `status`
   - `command` or provider metadata
   - `cwd` if local
   - `envFingerprint`
   - `port`
   - `url`
   - `provider` / `providerRef`
   - `ownerAgentId`
   - `startedByRunId`
   - `lastUsedAt`
   - `stopPolicy`
3. Introduce a deterministic `reuseKey`, for example:
   - `projectWorkspaceId + serviceName + envFingerprint`
4. Reuse policy:
   - if a healthy service with the same reuse key exists, attach to it
   - otherwise start a new service
5. Distinguish lifecycle classes:
   - `shared`: reusable across runs, usually scoped to `project_workspace`
   - `ephemeral`: tied to `execution_workspace` or `run`
6. Shutdown policy:
   - `run` scope: stop when run ends
   - `execution_workspace` scope: stop when workspace is cleaned up
   - `project_workspace` scope: stop on idle timeout, explicit stop, or workspace removal
   - `agent` scope: stop when ownership is transferred or agent policy requires it
7. Health policy:
   - readiness check at startup
   - periodic or on-demand liveness checks
   - mark unhealthy before killing when possible

Acceptance:

- Paperclip can decide whether to reuse or start a fresh service deterministically
- local and remote services share a normalized tracking model
- shutdown is policy-driven instead of implicit
- board can understand why a service was kept, reused, or stopped

## Phase 6: Adapter Integration

1. Update `codex_local` to consume resolved execution workspace cwd.
2. Update `claude_local` to consume resolved execution workspace cwd.
3. Define a normalized adapter contract for remote adapters that receive execution workspace intent instead of a host-local cwd.
4. Optionally allow Claude-specific optimization paths using native `--worktree`, but keep the shared server-side checkout strategy as canonical for local adapters.
5. Define how adapters return runtime service realizations:
   - local host-managed service reference
   - remote provider-managed service reference

Acceptance:

- adapter behavior remains unchanged when strategy is absent
- session resume remains cwd-safe
- no adapter is forced into git behavior
- remote adapters can implement equivalent isolation without pretending to be local worktrees
- adapters can report service URLs and lifecycle metadata in a normalized shape

## Phase 7: Visibility and Issue Comments

1. Expose execution workspace metadata in run details and optionally issue detail UI:
   - strategy
   - cwd
   - branch
   - runtime service refs
2. Expose runtime services with:
   - service name
   - status
   - URL
   - scope
   - owner
   - health
3. Add standard issue comment output when a worktree-backed or remotely isolated run starts:
   - branch
   - worktree path
   - service URLs if present

Acceptance:

- board can see where the agent is working
- board can see what runtime services exist for that workspace
- issue thread becomes the handoff surface for branch names and reachable URLs

## Phase 8: Cleanup Policies

1. Implement cleanup policies:
   - `manual`
   - `on_done`
   - `on_merged`
2. For worktree cleanup:
   - stop tracked runtime services if owned by the workspace lifecycle
   - remove worktree
   - optionally delete local branch after merge
3. Start with conservative defaults:
   - do not auto-delete anything unless explicitly configured

Acceptance:

- cleanup is safe and reversible by default
- merge-based cleanup can be introduced after basic lifecycle is stable

## Phase 9: Auth Ergonomics Follow-Up

This is related, but should be tracked separately from the workspace strategy work.

Needed improvement:

- make manual local agent bootstrap in authenticated/private mode easier, so operators can become `codexcoder` or `claudecoder` locally without depending on an already-established browser-auth CLI context

This should likely take the form of a local operator bootstrap flow, not a weakening of runtime auth boundaries.

## Rollout Strategy

1. Ship the shared config contract and no-op-compatible heartbeat changes first.
2. Pilot with `codexcoder` and `claudecoder` only.
3. Test against Paperclip-on-Paperclip workflows first.
4. Keep `project_primary` as the default for all existing agents.
5. Add UI exposure and cleanup only after the core runtime path is stable.

## Acceptance Criteria

1. Worktree behavior is optional, not a global requirement.
2. Project workspaces remain the canonical repo anchor.
3. Local coding agents can opt into isolated issue-scoped execution workspaces.
4. The same model works for both `codex_local` and `claude_local` without forcing a tool-specific abstraction into core.
5. Remote adapters can consume the same execution workspace intent without requiring host-local filesystem access.
6. Session continuity remains correct because each adapter resumes relative to its realized execution workspace.
7. Workspace runtime services are modeled generically, not as Paperclip-specific dev-server toggles.
8. Board users can see branch/path/URL information for worktree-backed or remotely isolated runs.
9. Service reuse and shutdown are deterministic and policy-driven.
10. Cleanup is conservative by default.

## Recommended Initial Scope

To keep this tractable, the first implementation should:

- support only local coding adapters
- support only `project_primary` and `git_worktree`
- avoid a new dedicated database table for worktrees
- start with a single host-managed runtime service implementation path
- postpone merge-driven cleanup automation until after basic start/run/visibility is proven

That is enough to validate the local product shape without prematurely freezing the wrong abstraction.

Follow-up expansion after that validation:

- define the remote adapter contract for adapter-managed isolated checkouts
- add one cloud/sandbox adapter implementation path
- normalize realized metadata so local and remote execution workspaces appear similarly in the UI
- expand the runtime service registry from local host-managed services to remote adapter-managed services
