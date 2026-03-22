# 工作区技术实现规格

## 本文档的角色

本文档将 [workspace-product-model-and-work-product.md](/Users/dotta/paperclip-subissues/doc/plans/workspace-product-model-and-work-product.md) 转化为可实施的工程计划。

它有意是具体的：

- 数据库和迁移形态
- 共享契约更新
- 路由和服务变更
- UI 变更
- 上线和兼容规则

这是第一个工作区感知交付切片的实现目标。

## 已锁定决策

以下决策在本次实现中视为已定：

1. 现在添加新的持久 `execution_workspaces` 表。
2. 每个任务同时最多有一个当前执行工作区。
3. `issues` 获得显式的 `project_workspace_id` 和 `execution_workspace_id`。
4. 工作区复用在 V1 范围内。
5. 功能在 UI 中通过 `/instance/settings > Experimental > Workspaces` 门控。
6. 门控仅限 UI。后端模型变更和迁移始终发布。
7. 现有用户升级到兼容保留的默认值。
8. `project_workspaces` 就地演进而非被替换。
9. 工作产出以任务为先，可选链接到执行工作区和运行时服务。
10. GitHub 是第一个切片中唯一的 PR 提供商。
11. `adapter_managed` 和 `cloud_sandbox` 执行模式都在范围内。
12. 工作区控制首先在现有项目属性中发布，而非在新的全局导航区域中。
13. 子任务不在本次实现切片范围内。

## 非目标

- 构建完整的代码审查系统
- 在本切片中解决子任务 UX
- 在本切片中实现跨项目的可复用共享工作区定义
- 在引入执行工作区之前重做所有当前运行时服务行为

## 现有基线

仓库已有：

- `project_workspaces`
- `projects.execution_workspace_policy`
- `issues.execution_workspace_settings`
- `workspace_runtime_services` 中的运行时服务持久化
- `workspace-runtime.ts` 中的本地 git-worktree 实现

本次实现应在该基线上构建而非分叉。

## 术语

- `项目工作区`：项目的持久配置代码库/根目录
- `执行工作区`：一个或多个任务使用的实际运行时工作区
- `工作产出`：面向用户的输出，如 PR、预览、分支、提交、产物、文档
- `运行时服务`：为工作区拥有或跟踪的进程或服务
- `兼容模式`：升级安装中保留的现有行为，无显式工作区选择

## 架构摘要

第一个切片应引入三个显式层：

1. `项目工作区`
   - 现有的持久项目范围代码库记录
   - 扩展以支持本地、git、非 git 和远程管理形态

2. `执行工作区`
   - 新的持久运行时记录
   - 表示共享、隔离、操作者分支或远程管理的执行上下文

3. `任务工作产出`
   - 新的持久输出记录
   - 存储 PR、预览、分支、提交、产物和文档

任务保持为规划和所有权单元。
执行工作区保持为运行时单元。
工作产出保持为可交付/输出单元。

## 配置和部署拓扑

## 重要纠正

此仓库已使用 `PAPERCLIP_DEPLOYMENT_MODE` 来控制认证/部署行为（`local_trusted | authenticated`）。

不要为工作区执行拓扑重载该变量。

## 新环境变量

添加单独的执行主机提示：

- `PAPERCLIP_EXECUTION_TOPOLOGY=local|cloud|hybrid`

默认：

- 如果未设置，视为 `local`

目的：

- 影响工作区配置的默认值和验证
- 不改变当前认证/部署语义
- 不破坏现有安装

### 语义

- `local`
  - Paperclip 可以创建主机本地的 worktree、进程和路径
- `cloud`
  - Paperclip 应假设没有持久的主机本地执行工作区管理
  - 适配器管理和云沙箱流程应视为一等
- `hybrid`
  - 本地和远程执行策略可能共存

这在第一个切片中是护栏和默认辅助，而非硬策略引擎。

## 实例设置

在 `/instance/settings` 下添加新的 `实验性` 部分。

### 新设置

- `experimental.workspaces: boolean`

规则：

- 默认 `false`
- 仅 UI 门控
- 存储在实例配置或实例设置 API 响应中
- 后端路由和迁移即使为 false 时也保持可用

### 关闭时的 UI 行为

- 隐藏工作区特定的任务控制
- 隐藏工作区特定的项目配置
- 如果 `工作产出` 标签页本来为空则隐藏
- 不移除或无效化任何已存储的工作区数据

## 数据模型

## 1. 扩展 `project_workspaces`

当前表已存在，应就地演进。

### 新列

- `source_type text not null default 'local_path'`
  - `local_path | git_repo | non_git_path | remote_managed`
- `default_ref text null`
- `visibility text not null default 'default'`
  - `default | advanced`
- `setup_command text null`
- `cleanup_command text null`
- `remote_provider text null`
  - 示例：`github`、`openai`、`anthropic`、`custom`
- `remote_workspace_ref text null`
- `shared_workspace_key text null`
  - 为未来跨项目共享工作区定义预留

### 回填规则

- 如果现有行有 `repo_url`，回填 `source_type='git_repo'`
- 否则如果现有行有 `cwd`，回填 `source_type='local_path'`
- 否则回填 `source_type='remote_managed'`
- 将现有 `repo_ref` 复制到 `default_ref`

### 索引

- 保留当前索引
- 添加 `(project_id, source_type)`
- 添加 `(company_id, shared_workspace_key)` 非唯一，为未来支持

## 2. 添加 `execution_workspaces`

创建新的持久表。

### 列

- `id uuid pk`
- `company_id uuid not null`
- `project_id uuid not null`
- `project_workspace_id uuid null`
- `source_issue_id uuid null`
- `mode text not null`
  - `shared_workspace | isolated_workspace | operator_branch | adapter_managed | cloud_sandbox`
- `strategy_type text not null`
  - `project_primary | git_worktree | adapter_managed | cloud_sandbox`
- `name text not null`
- `status text not null default 'active'`
  - `active | idle | in_review | archived | cleanup_failed`
- `cwd text null`
- `repo_url text null`
- `base_ref text null`
- `branch_name text null`
- `provider_type text not null default 'local_fs'`
  - `local_fs | git_worktree | adapter_managed | cloud_sandbox`
- `provider_ref text null`
- `derived_from_execution_workspace_id uuid null`
- `last_used_at timestamptz not null default now()`
- `opened_at timestamptz not null default now()`
- `closed_at timestamptz null`
- `cleanup_eligible_at timestamptz null`
- `cleanup_reason text null`
- `metadata jsonb null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

### 外键

- `company_id -> companies.id`
- `project_id -> projects.id`
- `project_workspace_id -> project_workspaces.id on delete set null`
- `source_issue_id -> issues.id on delete set null`
- `derived_from_execution_workspace_id -> execution_workspaces.id on delete set null`

### 索引

- `(company_id, project_id, status)`
- `(company_id, project_workspace_id, status)`
- `(company_id, source_issue_id)`
- `(company_id, last_used_at desc)`
- `(company_id, branch_name)` 非唯一

## 3. 扩展 `issues`

添加显式工作区链接。

### 新列

- `project_workspace_id uuid null`
- `execution_workspace_id uuid null`
- `execution_workspace_preference text null`
  - `inherit | shared_workspace | isolated_workspace | operator_branch | reuse_existing`

### 外键

- `project_workspace_id -> project_workspaces.id on delete set null`
- `execution_workspace_id -> execution_workspaces.id on delete set null`

### 回填规则

- 所有现有任务获得 null 值
- null 应被解释为兼容/继承行为

### 不变量

- 如果设置了 `project_workspace_id`，它必须属于任务的项目和公司
- 如果设置了 `execution_workspace_id`，它必须属于任务的公司
- 如果设置了 `execution_workspace_id`，引用工作区的 `project_id` 必须与任务的 `project_id` 匹配

## 4. 添加 `issue_work_products`

为输出创建新的持久表。

### 列

- `id uuid pk`
- `company_id uuid not null`
- `project_id uuid null`
- `issue_id uuid not null`
- `execution_workspace_id uuid null`
- `runtime_service_id uuid null`
- `type text not null`
  - `preview_url | runtime_service | pull_request | branch | commit | artifact | document`
- `provider text not null`
  - `paperclip | github | vercel | s3 | custom`
- `external_id text null`
- `title text not null`
- `url text null`
- `status text not null`
  - `active | ready_for_review | approved | changes_requested | merged | closed | failed | archived`
- `review_state text not null default 'none'`
  - `none | needs_board_review | approved | changes_requested`
- `is_primary boolean not null default false`
- `health_status text not null default 'unknown'`
  - `unknown | healthy | unhealthy`
- `summary text null`
- `metadata jsonb null`
- `created_by_run_id uuid null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

### 外键

- `company_id -> companies.id`
- `project_id -> projects.id on delete set null`
- `issue_id -> issues.id on delete cascade`
- `execution_workspace_id -> execution_workspaces.id on delete set null`
- `runtime_service_id -> workspace_runtime_services.id on delete set null`
- `created_by_run_id -> heartbeat_runs.id on delete set null`

### 索引

- `(company_id, issue_id, type)`
- `(company_id, execution_workspace_id, type)`
- `(company_id, provider, external_id)`
- `(company_id, updated_at desc)`

## 5. 扩展 `workspace_runtime_services`

此表已存在，应继续作为拥有/跟踪服务的记录系统。

### 新列

- `execution_workspace_id uuid null`

### 外键

- `execution_workspace_id -> execution_workspaces.id on delete set null`

### 行为

- 运行时服务保持以工作区为先
- 任务 UI 应通过链接的执行工作区和工作产出展示它们

## 共享契约

## 1. `packages/shared`

### 更新项目工作区类型和校验器

添加字段：

- `sourceType`
- `defaultRef`
- `visibility`
- `setupCommand`
- `cleanupCommand`
- `remoteProvider`
- `remoteWorkspaceRef`
- `sharedWorkspaceKey`

### 添加执行工作区类型和校验器

新共享类型：

- `ExecutionWorkspace`
- `ExecutionWorkspaceMode`
- `ExecutionWorkspaceStatus`
- `ExecutionWorkspaceProviderType`

### 添加工作产出类型和校验器

新共享类型：

- `IssueWorkProduct`
- `IssueWorkProductType`
- `IssueWorkProductStatus`
- `IssueWorkProductReviewState`

### 更新任务类型和校验器

添加：

- `projectWorkspaceId`
- `executionWorkspaceId`
- `executionWorkspacePreference`
- `workProducts?: IssueWorkProduct[]`

### 扩展项目执行策略契约

用更显式的形态替换当前狭窄的策略：

- `enabled`
- `defaultMode`
  - `shared_workspace | isolated_workspace | operator_branch | adapter_default`
- `allowIssueOverride`
- `defaultProjectWorkspaceId`
- `workspaceStrategy`
- `branchPolicy`
- `pullRequestPolicy`
- `runtimePolicy`
- `cleanupPolicy`

V1 中不要尝试编码每个可能的提供商特定字段。在需要时将提供商特定的可扩展性保留在嵌套 JSON 中。

## 服务层变更

## 1. 项目服务

更新项目工作区 CRUD 以处理扩展的数据库。

### 必需规则

- 设置主工作区时，清除兄弟上的 `is_primary`
- `source_type=remote_managed` 可以有 null `cwd`
- 本地/git 支持的工作区仍应要求 `cwd` 或 `repo_url` 之一
- 为仅发送 `cwd/repoUrl/repoRef` 的现有调用者保留当前行为

## 2. 任务服务

更新创建/更新流程以处理显式工作区绑定。

### 创建行为

按此顺序解析默认值：

1. 请求中显式的 `projectWorkspaceId`
2. `project.executionWorkspacePolicy.defaultProjectWorkspaceId`
3. 项目的主工作区
4. null

解析 `executionWorkspacePreference`：

1. 显式请求字段
2. 项目策略默认值
3. 兼容回退到 `inherit`

不要在任务创建时创建执行工作区，除非：

- 显式选择了 `reuse_existing` 并提供了 `executionWorkspaceId`

否则，工作区实现在执行开始时发生。

### 更新行为

- 仅当工作区属于同一项目时才允许更改 `projectWorkspaceId`
- 仅当执行工作区属于同一公司和项目时才允许设置 `executionWorkspaceId`
- 工作区链接变更时不要自动销毁或重新链接历史工作产出

## 3. 工作区实现服务

重构 `workspace-runtime.ts` 使实现产生或复用 `execution_workspaces` 行。

### 新流程

输入：

- 任务
- 项目工作区
- 项目执行策略
- 执行拓扑提示
- 适配器/运行时配置

输出：

- 已实现的执行工作区记录
- 运行时 cwd/提供商元数据

### 必需模式

- `shared_workspace`
  - 复用表示项目主/共享工作区的稳定执行工作区
- `isolated_workspace`
  - 创建或复用派生的隔离执行工作区
- `operator_branch`
  - 创建或复用长期分支工作区
- `adapter_managed`
  - 创建带提供商引用和可选 null `cwd` 的执行工作区
- `cloud_sandbox`
  - 与 adapter_managed 相同，但具有显式的远程沙箱语义

### 复用规则

当请求 `reuse_existing` 时：

- 仅列出活跃或近期使用的执行工作区
- 仅限同一项目
- 如果指定了项目工作区则仅限同一项目工作区
- 排除已归档和清理失败的工作区

### 共享工作区实现

对于兼容模式和共享工作区项目：

- 在首次需要时为每个项目工作区创建稳定的执行工作区
- 后续运行复用它

这避免了后续工作产出链接中的特殊情况分支。

## 4. 运行时服务集成

当运行时服务启动或复用时：

- 填充 `execution_workspace_id`
- 继续填充 `project_workspace_id`、`project_id` 和 `issue_id`

当运行时服务产生 URL 时：

- 可选地创建或更新 `runtime_service` 或 `preview_url` 类型的链接 `issue_work_products` 行

## 5. PR 和预览报告

添加创建/更新 `issue_work_products` 的服务。

### 支持的 V1 产品类型

- `pull_request`
- `preview_url`
- `runtime_service`
- `branch`
- `commit`
- `artifact`
- `document`

### GitHub PR 报告

V1 中 GitHub 是唯一具有更丰富语义的提供商。

支持的状态：

- `draft`
- `ready_for_review`
- `approved`
- `changes_requested`
- `merged`
- `closed`

在 `status` 和 `review_state` 中表示这些，而非在 V1 中发明单独的 PR 表。

## 路由和 API

## 1. 项目工作区路由

扩展现有路由：

- `GET /projects/:id/workspaces`
- `POST /projects/:id/workspaces`
- `PATCH /projects/:id/workspaces/:workspaceId`
- `DELETE /projects/:id/workspaces/:workspaceId`

### 新接受/返回的字段

- `sourceType`
- `defaultRef`
- `visibility`
- `setupCommand`
- `cleanupCommand`
- `remoteProvider`
- `remoteWorkspaceRef`

## 2. 执行工作区路由

添加：

- `GET /companies/:companyId/execution-workspaces`
  - 过滤器：
    - `projectId`
    - `projectWorkspaceId`
    - `status`
    - `issueId`
    - `reuseEligible=true`
- `GET /execution-workspaces/:id`
- `PATCH /execution-workspaces/:id`
  - V1 中仅更新状态/元数据/清理字段

暂不为这些路由添加顶级导航。

## 3. 工作产出路由

添加：

- `GET /issues/:id/work-products`
- `POST /issues/:id/work-products`
- `PATCH /work-products/:id`
- `DELETE /work-products/:id`

### V1 变更权限

- 看板可以创建/更新/删除所有
- 智能体可以为其被分配或当前执行的任务创建/更新
- 删除在链接到历史输出后通常应归档而非硬删除

## 4. 任务路由

扩展现有创建/更新载荷以接受：

- `projectWorkspaceId`
- `executionWorkspacePreference`
- `executionWorkspaceId`

扩展 `GET /issues/:id` 以返回：

- `projectWorkspaceId`
- `executionWorkspaceId`
- `executionWorkspacePreference`
- `currentExecutionWorkspace`
- `workProducts[]`

## 5. 实例设置路由

添加支持：

- 读写 `experimental.workspaces`

这仅是 UI 门控。

如果还没有通用的实例设置存储，第一个切片可以将其存储在 `/instance/settings` 使用的现有配置/实例设置机制中。

## UI 变更

## 1. `/instance/settings`

添加部分：

- `实验性`
  - `启用工作区`

关闭时：

- 隐藏新的工作区特定功能
- 不改变现有项目或任务行为

## 2. 项目属性

暂不创建单独的 `代码` 标签页。
先在现有项目属性中发布。

### 添加或重新启用的部分

- `项目工作区`
- `执行默认值`
- `预配置`
- `Pull Request`
- `预览和运行时`
- `清理`

### 显示规则

- 仅在 `experimental.workspaces=true` 时显示
- 措辞足够通用以适用于本地和远程设置
- 仅在 `sourceType=git_repo` 时显示 git 特定字段
- 非 `remote_managed` 时才显示本地路径特定字段

## 3. 任务创建对话框

当工作区实验标志开启且选定项目有工作区自动化或工作区时：

### 基础字段

- `代码库`
  - 从项目工作区中选择
  - 默认为策略默认或主工作区
- `执行模式`
  - `项目默认`
  - `共享工作区`
  - `隔离工作区`
  - `操作者分支`

### 高级部分

- `复用现有执行工作区`

此控件应仅查询：

- 同一项目
- 如果选定了则同一代码库
- 活跃/近期工作区
- 带分支或工作区名称的紧凑标签

不要在嘈杂的未过滤列表中公开所有执行工作区。

## 4. 任务详情

当以下条件满足时添加 `工作产出` 标签页：

- 实验标志开启，或
- 任务已有工作产出

### 显示

- 当前执行工作区摘要
- PR 卡片
- 预览卡片
- 分支/提交行
- 产物/文档

添加紧凑的页头标签：

- 代码库
- 工作区
- PR 数量/状态
- 预览状态

## 5. 执行工作区详情页面

添加详情路由但无导航项。

从以下链接：

- 任务工作产出标签页
- 项目工作区/执行面板

### 显示

- 身份和状态
- 项目工作区来源
- 源任务
- 链接的任务
- 分支/引用/提供商信息
- 运行时服务
- 工作产出
- 清理状态

## 运行时和适配器行为

## 1. 本地适配器

对于本地适配器：

- 继续使用现有的 cwd/worktree 实现路径
- 将结果持久化为执行工作区
- 将运行时服务和工作产出附加到执行工作区和任务

## 2. 远程或云适配器

对于远程适配器：

- 允许 `cwd` 为 null 的执行工作区
- 要求足以识别远程工作区/会话的提供商元数据
- 允许在无任何主机本地进程所有权的情况下创建工作产出

示例：

- 云编码智能体在 GitHub 上打开分支和 PR
- Vercel 预览 URL 作为预览工作产出报告回来
- 远程沙箱发出产物 URL

## 3. 审批感知的 PR 工作流

V1 应支持更丰富的 PR 状态跟踪，但不是完整的审查引擎。

### 必需操作

- `open_pr`
- `mark_ready`

### 必需审查状态

- `draft`
- `ready_for_review`
- `approved`
- `changes_requested`
- `merged`
- `closed`

### 存储方案

- 将这些表示为 `type='pull_request'` 的 `issue_work_products`
- 使用 `status` 和 `review_state`
- 在 `metadata` 中存储提供商特定细节

## 迁移计划

## 1. 现有安装

迁移姿态默认向后兼容。

### 保证

- 现有项目在继续工作前不需要编辑
- 现有任务流程不应开始要求工作区输入
- 所有新的可空列在缺失时必须保留当前行为

## 2. 项目工作区迁移

就地迁移 `project_workspaces`。

### 回填

- 派生 `source_type`
- 将 `repo_ref` 复制到 `default_ref`
- 新的可选字段留 null

## 3. 任务迁移

不要在所有现有任务上回填 `project_workspace_id` 或 `execution_workspace_id`。

原因：

- 最安全的迁移是保留当前运行时行为，仅在使用新的工作区感知流程时显式绑定

将旧任务解释为：

- `executionWorkspacePreference = inherit`
- 兼容/共享行为

## 4. 运行时历史迁移

不要在迁移本身中尝试完美的执行工作区历史重建。

相反：

- 从第一次新运行开始向前创建执行工作区记录
- 如果证明有价值，可选地后续为近期运行时服务添加回填工具

## 上线顺序

## 阶段 1：数据库和共享契约

1. 扩展 `project_workspaces`
2. 添加 `execution_workspaces`
3. 添加 `issue_work_products`
4. 扩展 `issues`
5. 扩展 `workspace_runtime_services`
6. 更新共享类型和校验器

## 阶段 2：服务接线

1. 更新项目工作区 CRUD
2. 更新任务创建/更新解析
3. 重构工作区实现以持久化执行工作区
4. 将运行时服务附加到执行工作区
5. 添加工作产出服务和持久化

## 阶段 3：API 和 UI

1. 添加执行工作区路由
2. 添加工作产出路由
3. 添加实例实验性设置切换
4. 在标志后面重新启用和修订项目工作区 UI
5. 在标志后面添加任务创建/更新控制
6. 添加任务工作产出标签页
7. 添加执行工作区详情页面

## 阶段 4：提供商集成

1. GitHub PR 报告
2. 预览 URL 报告
3. 运行时服务到工作产出链接
4. 远程/云提供商引用

## 验收标准

1. 现有安装继续可预测地运行，无需重新配置。
2. 项目可以定义本地、git、非 git 和远程管理的项目工作区。
3. 任务可以显式选择项目工作区和执行偏好。
4. 每个任务可以指向一个当前执行工作区。
5. 多个任务可以有意复用同一执行工作区。
6. 执行工作区对本地和远程执行流程都持久化。
7. 工作产出可以附加到任务，可选链接执行工作区。
8. GitHub PR 可以用更丰富的生命周期状态表示。
9. 实验标志关闭时主 UI 保持简单。
10. 此首个切片不需要顶级工作区导航。

## 风险和缓解

## 风险：过多重叠的工作区概念

缓解：

- 将任务 UI 限制在 `代码库` 和 `执行模式`
- 将执行工作区细节保留给高级页面

## 风险：升级时破坏当前项目

缓解：

- 可空的数据库增列
- 就地 `project_workspaces` 迁移
- 兼容默认值

## 风险：仅本地假设泄漏到云模式

缓解：

- 使执行工作区的 `cwd` 可选
- 使用 `provider_type` 和 `provider_ref`
- 使用 `PAPERCLIP_EXECUTION_TOPOLOGY` 作为默认护栏

## 风险：过早将 PR 变成定制子系统

缓解：

- V1 中将 PR 表示为工作产出
- 在 metadata 中保留提供商特定细节
- 除非使用证明有必要，否则推迟专用 PR 表

## 推荐的首个工程切片

如果我们想要最窄的有用实现：

1. 扩展 `project_workspaces`
2. 添加 `execution_workspaces`
3. 用显式工作区字段扩展 `issues`
4. 从现有本地工作区实现中持久化执行工作区
5. 添加 `issue_work_products`
6. 在实验标志后面显示项目工作区控制和任务工作区控制
7. 添加带 PR/预览/运行时服务显示的任务 `工作产出` 标签页

此切片足以验证模型，而无需构建每个提供商集成或清理工作流。
