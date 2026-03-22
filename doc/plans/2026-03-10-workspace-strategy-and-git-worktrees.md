# 工作区策略和 Git Worktree

## 背景

`PAP-447` 提出了 Paperclip 应如何支持 worktree 驱动的编码工作流，以便本地编码智能体使用，同时不将其变成通用的产品需求。

驱动用例很有说服力：

- 当任务开始时，本地编码智能体可能需要自己的隔离检出
- 智能体可能需要一个专用分支和可预测的推送路径
- 智能体可能需要启动一个或多个长期运行的工作区运行时服务，发现可达端口或 URL，并将它们报告回任务中
- 工作流应复用同一个 Paperclip 实例和嵌入式数据库，而非创建空白环境
- 本地智能体认证应保持低摩擦

同时，我们不希望将"每个智能体都使用 git worktree"硬编码到 Paperclip 中：

- 一些操作者使用 Paperclip 来管理 Paperclip 本身，并大量使用 worktree
- 其他操作者完全不需要 worktree
- 并非每个适配器都运行在本地 git 仓库中
- 并非每个适配器都运行在与 Paperclip 相同的机器上
- Claude 和 Codex 暴露了不同的内置能力，因此 Paperclip 不应过度适配某一个工具

## 核心产品决策

Paperclip 应该建模**执行工作区**，而非 **worktree**。

更具体地说：

- 持久锚点是**项目工作区**或仓库检出
- 一个任务可以从该项目工作区派生一个临时的**执行工作区**
- 执行工作区的一种实现是 **git worktree**
- 适配器决定是否以及如何使用该派生工作区

这保持了抽象的可移植性：

- `项目工作区`是仓库/项目级别的概念
- `执行工作区`是运行的运行时检出/cwd
- `git worktree` 是创建该执行工作区的一种策略
- `工作区运行时服务`是附加到该工作区的长期运行进程或预览

这也使抽象对非本地适配器仍然有效：

- 本地适配器可以接收由 Paperclip 生成的真实文件系统 cwd
- 远程或云端适配器可以接收相同的执行意图（结构化形式），并在自己的环境中实现
- Paperclip 不应假设每个适配器都能直接看到或使用主机文件系统路径

## 对主要框架问题的回答

### Worktree 是针对智能体还是仓库/项目的？

应该将其视为**仓库/项目范围的基础设施**，而非智能体身份。

稳定的对象是项目工作区。智能体来来去去，所有权会变更，同一任务可能被重新分配。Git worktree 是仓库工作区针对特定任务或任务的派生检出。智能体使用它，但不应拥有该抽象。

如果 Paperclip 将 worktree 设计为智能体优先，它会模糊：

- 智能体主目录
- 项目仓库根目录
- 任务特定的分支/检出

这会使复用、重新分配、清理和 UI 可见性变得更困难。

### 如何保留灵活性？

通过使执行工作区策略**在适配器/配置层面上可选启用**，而非作为全局不变量。

默认值应保持：

- 现有的项目工作区解析
- 现有的任务会话恢复
- 现有的智能体主目录回退

然后本地编码智能体可以选择启用 `git_worktree` 等策略。

### 如何使其可移植且适配器适当？

通过分离职责：

- Paperclip 核心解析并记录执行工作区状态
- 共享的本地运行时辅助函数可以实现基于 git 的检出策略
- 每个适配器使用适配器特定的标志在解析后的 cwd 中启动其工具

这避免了将 Claude 形状或 Codex 形状的模型强加给所有适配器。

它也避免了将主机文件系统模型强加给云端智能体。云端适配器可以将相同的请求策略解释为：

- 从仓库 + ref 创建新的沙箱检出
- 在提供者的远程环境中创建隔离的分支/工作区
- 忽略仅限本地的字段（如主机 cwd），同时仍然遵循分支/ref/隔离意图

## 产品和 UX 需求

当前的技术模型方向是正确的，但产品表面需要更清晰地分离：

- 通用的跨适配器**执行工作区**概念
- 用户可见的本地 git 实现概念——**隔离任务检出**
- 具体的 git 实现细节——**git worktree**

这些不应在 UI 中合并为一个标签。

### 术语建议

对于产品/UI 文案：

- 使用**执行工作区**表示通用的跨适配器概念
- 使用**隔离任务检出**表示面向用户的功能，当我们想说"这个任务有自己的分支/检出"时
- 将 **git worktree** 保留给高级或实现细节视图

这为 Paperclip 提供了支持以下内容的空间：

- 本地 git worktree
- 远程沙箱检出
- 适配器管理的远程工作区

而无需教会用户"工作区"总是意味着"我机器上的 git worktree"。

### 项目级默认值应驱动该功能

配置该功能的主要位置应是**项目**，而非智能体表单。

原因：

- 仓库/项目是否需要隔离任务检出主要是项目工作流决策
- 大多数操作者不希望为每个智能体配置运行时 JSON
- 智能体应继承项目的工作区策略，除非有强烈的适配器特定覆盖
- board 需要一个地方来表达仓库工作流默认值，如分支、PR、清理和预览生命周期

因此项目应拥有如下设置：

- `isolatedIssueCheckouts.enabled` 或等价项

这应该是该项目中新任务的默认驱动因素。

### 任务级使用应保持可选

即使项目支持隔离任务检出，也不应强制每个任务都使用。

示例：

- 小修复在主项目工作区中可能就够了
- 操作者可能想直接在长期分支上工作
- board 用户可能想创建任务而不承担设置/清理开销

因此模型应该是：

- 项目定义隔离任务检出是否可用及其默认值
- 每个任务在创建时可以选择启用或禁用
- 默认任务值可以从项目继承

这不应要求在正常任务创建流程中显示高级适配器配置。

### 运行时服务通常应从智能体表单中隐藏

当前的原始运行时服务 JSON 作为大多数本地智能体的主要 UI 来说太底层了。

对于 `claude_local` 和 `codex_local`，期望的行为可能是：

- Paperclip 使用项目/工作区策略在底层处理工作区运行时服务
- 操作者不需要在智能体表单中手工编写通用运行时 JSON
- 如果特定提供者的适配器后来需要更丰富的运行时配置，给它一个专门的 UI 而非默认的通用 JSON

因此 UI 建议是：

- 将运行时服务 JSON 排除在默认的本地智能体编辑体验之外
- 仅在高级部分或适配器特定的专家模式中允许
- 将常见的工作流设置上移到项目级工作区自动化设置

### PR 工作流需要明确的所有权和审批规则

一旦 Paperclip 创建隔离任务检出，它就隐式地触及了更大的工作流：

- 分支创建
- 运行时服务启动/停止
- 提交和推送
- PR 创建
- 合并或放弃后的清理

这意味着产品需要一个明确的模型来定义**谁拥有 PR 创建和合并就绪状态**。

至少有两种有效模式：

- 智能体管理的 PR 创建
- 审批门控的 PR 创建

可能还有三个不同的决策点：

1. 智能体应该自动提交吗？
2. 智能体应该自动创建 PR 吗？
3. 创建或标记就绪是否需要 board 审批？

这些不应埋藏在适配器 prompt 中。它们是工作流策略。

### 人类操作者工作流与任务隔离工作流不同

人类操作者可能想要一个长期的个人集成分支（如 `dotta`），不希望每个任务都创建新的分支/工作区流程。

这是一个合理的工作流，应该直接支持。

因此 Paperclip 应该区分：

- **隔离任务检出工作流**：为智能体并行性和任务范围隔离优化
- **个人分支工作流**：为人类或操作者在长期分支上进行多个相关变更并在方便时创建 PR 回主分支优化

这意味着：

- 即使可用，隔离任务检出也应该是可选的
- 项目工作流设置应支持"直接使用基准分支"或"使用首选操作者分支"路径
- PR 策略不应假设每个工作单元都一对一映射到新分支或 PR

## 推荐 UX 模型

### 1. 项目级"执行工作区"设置

项目应有一个专门的工作区自动化设置区域。

建议结构：

- `执行工作区`
  - `启用隔离任务检出`
  - `新任务的默认值`
  - `检出实现`
  - `分支和 PR 行为`
  - `运行时服务`
  - `清理行为`

对于本地 git 支撑的项目，可见语言可以更具体：

- `启用隔离任务检出`
- `实现：Git worktree`

对于远程或适配器管理的项目，同一部分可以改为：

- `实现：适配器管理的工作区`

### 2. 任务创建应暴露简单的启用选项

在启用了执行工作区支持的项目中创建任务时：

- 显示一个复选框或开关，如 `使用隔离任务检出`
- 从项目设置中继承默认值
- 除非操作者展开了高级部分，否则隐藏高级工作区控件

如果项目不支持执行工作区，则根本不显示该控件。

这保持了默认 UI 的轻量，同时保留了控制权。

### 3. 智能体配置应主要基于继承

智能体表单不应是操作者为常见本地智能体组装 worktree/运行时策略的主要位置。

相反：

- 本地编码智能体继承项目的执行工作区策略
- 智能体表单仅在确实必要时暴露覆盖
- 原始 JSON 配置仅限高级用户

这意味着常见情况变成：

- 配置一次项目
- 分配一个本地编码智能体
- 创建带有可选隔离检出行为的任务

### 4. 高级实现细节仍可存在

仍应有一个高级视图供高级用户查看：

- 执行工作区策略负载
- 运行时服务意图负载
- 适配器特定覆盖

但这应被视为专家/调试界面，而非默认的心智模型。

## 推荐的工作流策略模型

### 工作区实现策略

建议的策略值：

- `shared_project_workspace`
- `isolated_issue_checkout`
- `adapter_managed_isolated_workspace`

对于本地 git 项目，`isolated_issue_checkout` 可以映射到 `git_worktree`。

### 分支策略

建议的项目级分支策略字段：

- `baseBranch`
- `branchMode`: `issue_scoped | operator_branch | project_primary`
- `branchTemplate` 用于任务范围分支
- `operatorPreferredBranch` 用于人类/操作者工作流

这允许：

- 严格的智能体任务分支
- 人类的长期个人分支
- 需要时直接使用项目主工作区

### PR 策略

建议的项目级 PR 策略字段：

- `prMode`: `none | agent_may_open | agent_auto_open | approval_required`
- `autoPushOnDone`: boolean
- `requireApprovalBeforeOpen`: boolean
- `requireApprovalBeforeReady`: boolean
- `defaultBaseBranch`

这使 PR 行为保持明确和可治理。

### 清理策略

建议的项目级清理字段：

- `stopRuntimeServicesOnDone`
- `removeIsolatedCheckoutOnDone`
- `removeIsolatedCheckoutOnMerged`
- `deleteIssueBranchOnMerged`
- `retainFailedWorkspaceForInspection`

这些很重要，因为工作区自动化不仅仅是设置。清理路径是产品的一部分。

## 针对当前 UI 问题的设计建议

基于上述考虑，UI 应做出以下改变：

### 智能体 UI

- 从默认的本地智能体配置界面中移除通用运行时服务 JSON
- 将原始工作区/运行时 JSON 仅保留在高级设置中
- 对 `claude_local` 和 `codex_local` 优先从项目设置继承
- 仅在适配器确实需要 Paperclip 无法推断的设置时添加适配器特定的运行时 UI

### 项目 UI

- 添加项目级执行工作区设置部分
- 允许为该项目启用隔离任务检出
- 在此存储默认任务行为
- 在此暴露分支、PR、运行时服务和清理默认值

### 任务创建 UI

- 仅当项目启用了执行工作区支持时才显示 `使用隔离任务检出`
- 保持为任务级的启用/禁用，默认从项目继承
- 除非明确请求，否则隐藏高级执行工作区详情

## 对规格的影响

这以有益的方式改变了计划的重点：

- 项目成为主要的工作流配置所有者
- 任务成为隔离检出行为的启用/禁用单元
- 智能体成为通常继承工作流策略的执行者
- 原始运行时 JSON 成为高级/内部表示，而非主要 UX

它还澄清了 PR 创建和清理不是可选的旁注。它们是工作区自动化产品表面的核心部分。

## 具体集成检查清单

本节将上述产品需求转化为当前代码库的具体实施计划。

### 指导性优先级规则

运行时决策顺序应变为：

1. 任务级执行工作区覆盖
2. 项目级执行工作区策略
3. 智能体级适配器覆盖
4. 当前默认行为

这是关键的架构变更。目前的实现对于期望的 UX 来说过于以智能体配置为中心。

## 建议的字段名

### 项目级字段

添加项目拥有的执行工作区策略对象。建议的共享形状：

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

说明：

- `enabled` 控制项目是否暴露隔离任务检出行为
- `defaultMode` 控制任务创建默认值
- `implementation` 保持足够通用，适用于本地或远程适配器
- 运行时服务配置嵌套在此处，而非默认的智能体表单中

### 任务级字段

添加任务拥有的启用/覆盖字段。建议的形状：

```ts
type IssueExecutionWorkspaceSettings = {
  mode?: "inherit_project_default" | "shared_project_workspace" | "isolated_issue_checkout";
  branchOverride?: string | null;
  pullRequestModeOverride?: "inherit" | "none" | "agent_may_open" | "agent_auto_open" | "approval_required";
};
```

这通常应隐藏在简单的 UI 后面：

- 一个复选框如 `使用隔离任务检出`
- 仅在需要时显示高级控件

### 智能体级字段

保留智能体级工作区/运行时配置，但将其重新定位为仅限高级覆盖。

建议的语义：

- 如果不存在，则继承项目 + 任务策略
- 如果存在，则仅覆盖该适配器所需的实现细节

## 共享类型和 API 变更

### 1. 共享项目类型

首先变更的文件：

- `packages/shared/src/types/project.ts`
- `packages/shared/src/validators/project.ts`

添加：

- `executionWorkspacePolicy?: ProjectExecutionWorkspacePolicy | null`

### 2. 共享任务类型

变更的文件：

- `packages/shared/src/types/issue.ts`
- `packages/shared/src/validators/issue.ts`

添加：

- `executionWorkspaceSettings?: IssueExecutionWorkspaceSettings | null`

### 3. 数据库 Schema

如果我们希望这些字段直接持久化在现有实体上而非存储在不透明 JSON 中：

- `packages/db/src/schema/projects.ts`
- `packages/db/src/schema/issues.ts`
- `packages/db/src/migrations/` 中的迁移生成

建议的初始方案：

- 将项目策略存储为 `projects` 上的 JSONB
- 将任务设置覆盖存储为 `issues` 上的 JSONB

这在产品模型仍在变化的情况下最小化了 schema 变更。

建议的列：

- `projects.execution_workspace_policy jsonb`
- `issues.execution_workspace_settings jsonb`

## 服务端解析变更

### 4. 项目服务读写路径

文件：

- `server/src/services/projects.ts`
- `server/src/routes/projects.ts` 中的项目路由

任务：

- 接受并验证项目执行工作区策略
- 从项目 API 负载中返回它
- 像往常一样强制公司范围

### 5. 任务服务创建/更新路径

文件：

- `server/src/services/issues.ts`
- `server/src/routes/issues.ts`

任务：

- 接受任务级 `executionWorkspaceSettings`
- 在启用了执行工作区的项目中创建任务时，如果未明确提供，则从项目策略继承任务设置默认值
- 保持任务负载对普通客户端简洁；高级字段可以是可选的

### 6. 心跳和运行解析

主要文件：

- `server/src/services/heartbeat.ts`

当前行为应重构，使工作区解析基于：

- 任务设置
- 然后项目策略
- 然后适配器覆盖

具体技术工作：

- 在运行解析期间加载项目执行工作区策略
- 在运行解析期间加载任务执行工作区设置
- 在适配器启动前派生有效的执行工作区决策对象
- 保持适配器配置仅作为覆盖

建议的内部辅助函数：

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

## UI 变更

### 7. 项目设置 UI

可能涉及的文件：

- `ui/src/components/ProjectProperties.tsx`
- `ui/src/pages/` 下的项目详情/设置页面
- `ui/src/api/projects.ts` 中的项目 API 客户端

添加一个项目拥有的部分：

- `执行工作区`
  - 启用隔离任务检出
  - 新任务的默认值
  - 实现类型
  - 分支设置
  - PR 设置
  - 清理设置
  - 运行时服务默认值

重要的 UX 规则：

- 运行时服务配置不应默认为原始 JSON
- 如果初始版本必须在内部使用 JSON，则用最小化的结构化表单或高级折叠区域包装

### 8. 任务创建/编辑 UI

可能涉及的文件：

- `ui/src/pages/` 中的任务创建 UI 组件和任务详情编辑界面
- `ui/src/api/issues.ts` 中的任务 API 客户端

添加：

- `使用隔离任务检出` 开关，仅当项目策略启用时显示
- 仅在展开时显示高级工作区行为控件

不显示：

- 原始运行时服务 JSON
- 原始策略负载

在默认的任务创建流程中。

### 9. 智能体 UI 清理

文件：

- `ui/src/adapters/local-workspace-runtime-fields.tsx`
- `ui/src/adapters/codex-local/config-fields.tsx`
- `ui/src/adapters/claude-local/config-fields.tsx`

技术方向：

- 将现有配置界面保留为高级覆盖
- 从本地编码智能体的默认表单流程中移除
- 添加说明性文案，表明项目执行工作区策略除非被覆盖否则会被继承

## 适配器和编排变更

### 10. 本地适配器行为

文件：

- `packages/adapters/codex-local/src/ui/build-config.ts`
- `packages/adapters/claude-local/src/ui/build-config.ts`
- 已经消费 env/context 的本地适配器执行路径

任务：

- 继续接受来自心跳的已解析工作区/运行时上下文
- 停止假设智能体配置是工作区策略的主要来源
- 保留适配器特定的覆盖支持

### 11. 运行时服务编排

文件：

- `server/src/services/workspace-runtime.ts`

任务：

- 接受来自有效项目/任务策略的运行时服务默认值
- 将适配器配置的运行时服务 JSON 仅保留为覆盖
- 保持远程适配器的可移植性

## PR 和清理工作流

### 12. PR 策略执行

目前尚未完全实现，应作为单独的编排层处理。

可能涉及的文件：

- `server/src/services/heartbeat.ts`
- 未来的 git/提供者集成辅助函数

需要的决策：

- 任务移至完成时，Paperclip 应自动提交吗？
- 应自动推送吗？
- 应自动创建 PR 吗？
- PR 创建/就绪是否应该审批门控？

建议方案：

- 将 PR 策略存储在项目上
- 按任务/运行解析有效的 PR 策略
- 发出明确的工作流动作，而非仅依赖 prompt 文本

### 13. 清理策略执行

可能涉及的文件：

- `server/src/services/workspace-runtime.ts`
- `server/src/services/heartbeat.ts`
- 任何未来的合并检测钩子

需要的行为：

- 完成或合并时停止运行时服务
- 完成或合并时移除隔离检出
- 如果策略要求，合并后删除分支
- 可选保留失败的工作区以供检查

## 推荐的首次实施顺序

为了在不破坏系统稳定性的情况下整合这些想法，按以下顺序实施：

1. 将项目策略字段添加到共享类型、验证器、数据库、服务、路由和项目 UI。
2. 将任务级执行工作区设置字段添加到共享类型、验证器、数据库、服务、路由和任务创建/编辑 UI。
3. 重构心跳以从任务 -> 项目 -> 智能体覆盖计算有效的执行工作区策略。
4. 修改本地智能体 UI，使工作区/运行时 JSON 仅限高级用户。
5. 将默认运行时服务行为移至项目设置。
6. 添加明确的 PR 策略存储和解析。
7. 添加明确的清理策略存储和解析。

## 本产品转变的完成定义

当以下所有条件都为真时，此设计转变即完成：

- 项目设置拥有默认工作区策略
- 任务创建在可用时暴露简单的启用/禁用
- 本地智能体表单不再要求原始运行时 JSON 用于常见场景
- 心跳从项目 + 任务 + 覆盖优先级解析有效的工作区行为
- PR 和清理行为被建模为明确的策略，而非隐含的 prompt 行为
- UI 语言将执行工作区与本地 git worktree 实现细节区分开来

## 当前代码已支持的内容

Paperclip 已经具备了项目优先模型的正确基础。

### 项目工作区已经是一等公民

- `project_workspaces` 已存在于 `packages/db/src/schema/project_workspaces.ts`
- 共享的 `ProjectWorkspace` 类型已在 `packages/shared/src/types/project.ts` 中包含 `cwd`、`repoUrl` 和 `repoRef`
- 文档已说明智能体使用项目的主工作区执行项目范围的任务，见 `docs/api/goals-and-projects.md`

### 心跳已按正确顺序解析工作区

当前的运行解析已优先选择：

1. 项目工作区
2. 先前的任务会话 cwd
3. 智能体主目录回退

参见 `server/src/services/heartbeat.ts`。

### 会话恢复已经是 cwd 感知的

两个本地编码适配器都将会话连续性视为 cwd 绑定的：

- Codex: `packages/adapters/codex-local/src/server/execute.ts`
- Claude: `packages/adapters/claude-local/src/server/execute.ts`

这意味着干净的插入点在适配器执行之前：先解析最终的执行 cwd，然后让适配器正常运行。

### 服务端生成的本地认证已存在

对于服务端生成的本地适配器，Paperclip 已经注入短期本地 JWT：

- JWT 创建：`server/src/services/heartbeat.ts`
- 适配器 env 注入：
  - `packages/adapters/codex-local/src/server/execute.ts`
  - `packages/adapters/claude-local/src/server/execute.ts`

手动本地引导路径在认证模式下仍然较弱，但这是一个相关的认证易用性问题，而非将 worktree 作为核心不变量的理由。

## 来自供应商文档的工具观察

链接的工具文档支持项目优先、适配器特定的启动模型。

### Codex

- Codex 应用有原生的 worktree 概念用于 git 仓库中的并行任务
- Codex CLI 文档说明在选定的工作目录中运行并从当前工作目录恢复会话
- Codex CLI 未呈现单一的一等便携 CLI worktree 抽象供 Paperclip 直接镜像

含义：

- 对于 `codex_local`，Paperclip 通常应自己创建/选择检出，然后在该 cwd 中启动 Codex

### Claude

- Claude 文档记录了并行会话的明确 git worktree 工作流
- Claude CLI 支持 `--worktree` / `-w`
- Claude 会话也保持与目录上下文绑定

含义：

- `claude_local` 可以选择使用原生的 `--worktree`
- 但 Paperclip 仍应将其视为适配器优化，而非规范的跨适配器模型

## 本地与远程适配器

本计划必须明确考虑许多适配器不是本地的这一事实。

示例：

- 本地 CLI 适配器如 `codex_local` 和 `claude_local`
- 云托管的编码智能体如 Cursor 云端智能体
- 未来的托管 Codex 或 Claude 智能体模式
- 基于 E2B、Cloudflare 或类似环境构建的自定义沙箱适配器

这些适配器并非都共享相同的能力：

- 一些可以直接使用主机 git worktree
- 一些可以远程克隆仓库并创建分支
- 一些可能暴露虚拟工作区概念，没有直接的 git worktree 等价物
- 一些可能根本不允许持久化文件系统状态

因此，Paperclip 应该分离：

- **执行工作区意图**：我们想要什么隔离/分支/仓库行为
- **适配器实现**：特定适配器如何实现该行为

### 执行工作区意图

Paperclip 应能表达如下意图：

- 直接使用项目的主工作区
- 创建隔离的任务范围检出
- 基于给定的仓库 ref 工作
- 从任务派生分支名称
- 如果运行时服务已启动，暴露一个或多个可达的预览或服务 URL

### 适配器实现

适配器应可以自由地将该意图映射到自己的环境中：

- 本地适配器：创建主机 git worktree 并在该 cwd 中运行
- 云沙箱适配器：将仓库克隆到沙箱中，在那里创建分支，并返回沙箱元数据
- 托管的远程编码智能体：调用提供者 API 创建绑定到请求的分支/ref 的远程工作区/线程

重要的约束是，适配器以规范化形状报告回已实现的执行工作区元数据，即使底层实现不是 git worktree。

## 建议模型

使用三个层次：

1. `项目工作区`
2. `执行工作区`
3. `工作区运行时服务`
4. `适配器会话`

### 1. 项目工作区

长期仓库锚点。

示例：

- `./paperclip`
- 仓库 URL 和基准 ref
- 项目的主检出

### 2. 执行工作区

为特定任务/运行派生的运行时检出。

示例：

- 直接使用项目主工作区
- 从项目工作区派生的 git worktree
- 从仓库 URL + ref 派生的远程沙箱检出
- 适配器特定脚本生成的自定义检出

### 3. 适配器会话

与工作区关联的长期或半长期进程。

示例：

- 本地 Web 服务器
- 后台 worker
- 沙箱预览 URL
- 测试监视器
- 隧道进程

这些不是 Paperclip 特有的。它们是在开发工作区中工作的常见属性，无论是本地还是远程。

### 4. 适配器会话

Claude/Codex 的对话连续性和运行时状态，保持 cwd 感知，应跟随执行工作区而非定义它。

## 推荐的配置界面

在适配器配置中引入通用的执行工作区策略。

示例形状：

```json
{
  "workspaceStrategy": {
    "type": "project_primary"
  }
}
```

或：

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

远程适配器可能使用如下形状：

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

重要的是，`git_worktree` 是可以使用它的适配器的策略值，而非通用合约。

### 工作区运行时服务

不要将其建模为 Paperclip 特有的 `devServer` 标志。

相反，将其建模为工作区附加的运行时服务的通用列表。

示例形状：

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

此合约有意设计为通用的：

- `command` 可以启动任何工作区附加进程，而非仅限 Web 服务器
- 数据库复用通过 env/配置注入处理，而非产品特定的特殊情况
- 本地和远程适配器可以以不同方式实现相同的服务意图

### 服务意图与服务实现

Paperclip 应区分：

- **服务意图**：工作区需要什么类型的伴随运行时
- **服务实现**：本地或远程适配器实际如何启动和暴露它

示例：

- 本地适配器：
  - 启动 `pnpm dev`
  - 分配空闲主机端口
  - 对 localhost URL 进行健康检查
  - 报告 `{ pid, port, url }`
- 云沙箱适配器：
  - 在沙箱内启动预览进程
  - 接收提供者预览 URL
  - 报告 `{ sandboxId, previewUrl }`
- 托管的远程编码智能体：
  - 可能要求提供者创建预览环境
  - 报告提供者原生的工作区/服务元数据

Paperclip 应规范化报告的元数据，而不要求每个适配器看起来像主机本地进程。

通过 `packages/shared/src/types/issue.ts` 中现有的 `assigneeAdapterOverrides` 形状保持任务级覆盖的可能性。

## 各层职责

### Paperclip 核心

Paperclip 核心应：

- 为任务解析基础项目工作区
- 解析或请求执行工作区
- 配置时解析或请求工作区运行时服务
- 将执行工作区元数据注入运行上下文
- 持久化足够的元数据供 board 可见性和清理使用
- 在需要时管理围绕运行启动/完成的生命周期钩子

Paperclip 核心不应：

- 要求所有智能体使用 worktree
- 假设每个适配器都是本地且基于 git 的
- 假设每个运行时服务都是具有 PID 的 localhost 进程
- 将工具特定的 worktree prompt 编码为核心产品行为

### 共享本地运行时辅助函数

共享的服务端辅助函数应处理本地 git 机制：

- 验证仓库根目录
- 创建/选择分支
- 创建/选择 git worktree
- 分配空闲端口
- 可选启动和跟踪开发服务器
- 返回 `{ cwd, branchName, url }`

此辅助函数可被以下复用：

- `codex_local`
- `claude_local`
- 未来的本地适配器如 Cursor/OpenCode 等价物

此辅助函数有意仅用于本地适配器。远程适配器不应被强制通过主机本地 git 辅助函数。

### 共享运行时服务管理器

除了本地 git 辅助函数外，Paperclip 还应定义通用的运行时服务管理器合约。

其职责是：

- 决定已配置的服务应复用还是重新启动
- 需要时分配本地端口
- 当适配器/运行时实现为主机本地时启动和监控本地进程
- 为远程实现记录规范化的服务元数据
- 运行就绪性检查
- 向 board 显示服务 URL 和状态
- 应用关闭策略

此管理器不应硬编码为"开发服务器"。它应适用于任何长期运行的工作区伴随进程。

### 适配器

适配器应：

- 接受已解析的执行 cwd
- 或在没有主机 cwd 可用时接受结构化的执行工作区意图
- 当服务编排委托给适配器时接受结构化的工作区运行时服务意图
- 使用适配器特定的标志启动其工具
- 保持自己的会话连续性语义

例如：

- `codex_local`：在 cwd 中运行，可能使用 `--cd` 或进程 cwd
- `claude_local`：在 cwd 中运行，在有帮助时可选使用 `--worktree`
- 远程沙箱适配器：从仓库/ref/分支意图创建自己的隔离工作区，并将已实现的远程工作区元数据报告回 Paperclip

对于运行时服务：

- 本地适配器或共享主机管理器：启动本地进程并返回主机本地元数据
- 远程适配器：创建或复用远程预览/服务并返回规范化的远程元数据

## 最小数据模型新增

暂时不要创建完全一等公民的 `worktrees` 表。

从更小的范围开始，在运行、任务或两者上记录派生的执行工作区元数据。

建议引入的字段：

- `executionWorkspaceStrategy`
- `executionWorkspaceCwd`
- `executionBranchName`
- `executionWorkspaceStatus`
- `executionServiceRefs`
- `executionCleanupStatus`

这些可以首先存储在 `heartbeat_runs.context_snapshot` 或相邻的运行元数据上，如果 UI 和清理工作流证明合理，可以在后续移入专用表。

对于运行时服务，Paperclip 最终应跟踪规范化字段，如：

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

首次实现可以在需要时将其保存在运行元数据中，但长期形状是通用的运行时服务注册表，而非一次性的服务器 URL 字段。

## 具体实施计划

## 第一阶段：定义共享合约

1. 在 `packages/shared` 中引入共享的执行工作区策略合约。
2. 为以下内容添加适配器配置 schema 支持：
   - `workspaceStrategy.type`
   - `baseRef`
   - `branchTemplate`
   - `worktreeParentDir`
   - `cleanupPolicy`
   - 可选的工作区运行时服务设置
3. 保持现有的 `useProjectWorkspace` 标志作为底层兼容性控制。
4. 区分本地实现字段和通用意图字段，使远程适配器不被迫消费主机 cwd 值。
5. 定义通用的 `workspaceRuntime.services[]` 合约，包含：
   - 服务名称
   - 命令或提供者管理的意图
   - env 覆盖
   - 就绪性检查
   - 暴露元数据
   - 复用范围
   - 生命周期
   - 停止策略

验收标准：

- 适配器配置可以表达 `project_primary` 和 `git_worktree`
- 配置保持可选且向后兼容
- 运行时服务以通用方式表达，而非 Paperclip 特有的开发服务器标志

## 第二阶段：在心跳中解析执行工作区

1. 扩展心跳工作区解析使其可以返回更丰富的执行工作区结果。
2. 保持当前的回退顺序，但区分：
   - 基础项目工作区
   - 派生的执行工作区
3. 对本地适配器将已解析的执行工作区详情注入 `context.paperclipWorkspace`，对需要结构化远程实现的适配器注入通用的执行工作区意图负载。
4. 将已配置的运行时服务意图与执行工作区一起解析，使适配器或主机管理器接收完整的工作区运行时合约。

主要接触点：

- `server/src/services/heartbeat.ts`

验收标准：

- 未配置策略时运行仍保持不变
- 已解析的上下文清楚指示哪个策略产生了 cwd

## 第三阶段：添加共享本地 Git 工作区辅助函数

1. 创建服务端辅助模块用于本地仓库检出策略。
2. 实现 `git_worktree` 策略：
   - 在基础工作区 cwd 验证 git 仓库
   - 从任务派生分支名称
   - 创建或复用 worktree 路径
   - 干净地检测冲突
3. 返回结构化元数据：
   - 最终 cwd
   - 分支名称
   - worktree 路径
   - 仓库根目录

验收标准：

- 辅助函数可在单个适配器之外复用
- 对于给定的任务/配置，worktree 创建是确定性的
- 远程适配器不受此辅助函数影响

## 第四阶段：可选的开发服务器生命周期

将此阶段在概念上重命名为**工作区运行时服务生命周期**。

1. 在执行工作区创建时添加可选的运行时服务启动。
2. 支持以下两者：
   - 主机管理的本地服务
   - 适配器管理的远程服务
3. 对于本地服务：
   - 需要时在启动前分配空闲端口
   - 在正确的 cwd 中启动配置的命令
   - 运行就绪性检查
   - 注册已实现的元数据
4. 对于远程服务：
   - 让适配器在配置后返回规范化的服务元数据
   - 不假设 PID 或 localhost 访问
5. 发布或更新任务可见的元数据，包含服务 URL 和标签。

验收标准：

- 运行时服务启动保持可选
- 失败产生可操作的运行日志和任务评论
- 适当时同一嵌入式数据库/Paperclip 实例可通过 env/配置注入复用
- 远程服务实现在表示时不假装是本地进程

## 第五阶段：运行时服务复用、跟踪和关闭

1. 引入通用的运行时服务注册表。
2. 每个服务应跟踪：
   - `scopeType`: `project_workspace | execution_workspace | run | agent`
   - `scopeId`
   - `serviceName`
   - `status`
   - `command` 或提供者元数据
   - `cwd`（如果是本地的）
   - `envFingerprint`
   - `port`
   - `url`
   - `provider` / `providerRef`
   - `ownerAgentId`
   - `startedByRunId`
   - `lastUsedAt`
   - `stopPolicy`
3. 引入确定性的 `reuseKey`，例如：
   - `projectWorkspaceId + serviceName + envFingerprint`
4. 复用策略：
   - 如果存在具有相同复用键的健康服务，则附加到它
   - 否则启动新服务
5. 区分生命周期类别：
   - `shared`：跨运行可复用，通常范围为 `project_workspace`
   - `ephemeral`：绑定到 `execution_workspace` 或 `run`
6. 关闭策略：
   - `run` 范围：运行结束时停止
   - `execution_workspace` 范围：工作区清理时停止
   - `project_workspace` 范围：空闲超时、显式停止或工作区移除时停止
   - `agent` 范围：所有权转移或智能体策略要求时停止
7. 健康策略：
   - 启动时进行就绪性检查
   - 定期或按需进行存活检查
   - 尽可能在终止前标记为不健康

验收标准：

- Paperclip 可以确定性地决定是复用还是启动新服务
- 本地和远程服务共享规范化的跟踪模型
- 关闭是策略驱动的而非隐式的
- board 可以理解为什么服务被保留、复用或停止

## 第六阶段：适配器集成

1. 更新 `codex_local` 以消费已解析的执行工作区 cwd。
2. 更新 `claude_local` 以消费已解析的执行工作区 cwd。
3. 为接收执行工作区意图而非主机本地 cwd 的远程适配器定义规范化的适配器合约。
4. 可选允许 Claude 特定的优化路径使用原生 `--worktree`，但保持共享的服务端检出策略作为本地适配器的规范。
5. 定义适配器如何返回运行时服务实现：
   - 本地主机管理的服务引用
   - 远程提供者管理的服务引用

验收标准：

- 策略不存在时适配器行为保持不变
- 会话恢复保持 cwd 安全
- 没有适配器被强制使用 git 行为
- 远程适配器可以实现等价隔离而无需假装是本地 worktree
- 适配器可以以规范化形状报告服务 URL 和生命周期元数据

## 第七阶段：可见性和任务评论

1. 在运行详情和可选的任务详情 UI 中暴露执行工作区元数据：
   - 策略
   - cwd
   - 分支
   - 运行时服务引用
2. 暴露运行时服务，包含：
   - 服务名称
   - 状态
   - URL
   - 范围
   - 所有者
   - 健康状况
3. 当 worktree 支撑或远程隔离的运行启动时添加标准任务评论输出：
   - 分支
   - worktree 路径
   - 服务 URL（如果存在）

验收标准：

- board 可以看到智能体在哪里工作
- board 可以看到该工作区存在哪些运行时服务
- 任务线程成为分支名称和可达 URL 的交接界面

## 第八阶段：清理策略

1. 实现清理策略：
   - `manual`
   - `on_done`
   - `on_merged`
2. 对于 worktree 清理：
   - 如果由工作区生命周期拥有，则停止已跟踪的运行时服务
   - 移除 worktree
   - 合并后可选删除本地分支
3. 从保守的默认值开始：
   - 除非明确配置，否则不自动删除任何内容

验收标准：

- 默认清理是安全且可逆的
- 基于合并的清理可在基本生命周期稳定后引入

## 第九阶段：认证易用性后续跟进

这是相关的，但应与工作区策略工作分开跟踪。

需要的改进：

- 使认证/私有模式下的手动本地智能体引导更容易，让操作者可以在本地成为 `codexcoder` 或 `claudecoder`，而不依赖已建立的浏览器认证 CLI 上下文

这可能应以本地操作者引导流程的形式实现，而非削弱运行时认证边界。

## 发布策略

1. 首先发布共享配置合约和无操作兼容的心跳变更。
2. 仅在 `codexcoder` 和 `claudecoder` 上试点。
3. 首先针对 Paperclip-on-Paperclip 工作流测试。
4. 对所有现有智能体保持 `project_primary` 作为默认值。
5. 仅在核心运行时路径稳定后添加 UI 暴露和清理。

## 验收标准

1. Worktree 行为是可选的，而非全局需求。
2. 项目工作区保持为规范的仓库锚点。
3. 本地编码智能体可以选择启用隔离的任务范围执行工作区。
4. 相同的模型适用于 `codex_local` 和 `claude_local`，而不将工具特定的抽象强制引入核心。
5. 远程适配器可以消费相同的执行工作区意图，而不要求主机本地文件系统访问。
6. 会话连续性保持正确，因为每个适配器相对于其已实现的执行工作区恢复。
7. 工作区运行时服务以通用方式建模，而非 Paperclip 特有的开发服务器开关。
8. Board 用户可以看到 worktree 支撑或远程隔离运行的分支/路径/URL 信息。
9. 服务复用和关闭是确定性且策略驱动的。
10. 默认清理是保守的。

## 推荐的初始范围

为保持可控，首次实现应：

- 仅支持本地编码适配器
- 仅支持 `project_primary` 和 `git_worktree`
- 避免为 worktree 创建新的专用数据库表
- 从单一的主机管理运行时服务实现路径开始
- 将合并驱动的清理自动化推迟到基本的启动/运行/可见性验证完成之后

这足以验证本地产品形态而不过早固化错误的抽象。

在验证后的后续扩展：

- 为适配器管理的隔离检出定义远程适配器合约
- 添加一个云/沙箱适配器实现路径
- 规范化已实现的元数据，使本地和远程执行工作区在 UI 中呈现类似
- 将运行时服务注册表从本地主机管理的服务扩展到远程适配器管理的服务
