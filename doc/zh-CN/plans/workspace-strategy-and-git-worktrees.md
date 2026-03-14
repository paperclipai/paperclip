# 工作空间策略和 Git 工作树

## 上下文

`PAP-447` 询问 Paperclip 应如何支持本地编码智能体的工作树驱动编码工作流程，而不将其转变为通用产品需求。

激励用例很强大：

- 当问题开始时，本地编码智能体可能需要自己的独立检查
- 智能体可能需要一个专用分支和一个可预测的路径来稍后推送
- 智能体可能需要启动一个或多个长期存在的工作区运行时服务，发现可访问的端口或 URL，并将其报告回问题中
- 工作流程应重用相同的 Paperclip 实例和嵌入式数据库，而不是创建空白环境
- 本地智能体身份验证应保持低摩擦

同时，我们不想将“每个智能体都使用 git worktrees”硬编码到 Paperclip 中：

- 一些操作员使用 Paperclip 来管理 Paperclip 并且非常需要工作树
- 其他操作员根本不需要工作树
- 并非每个适配器都在本地 git 存储库中运行
- 并非每个适配器都与 Paperclip 在同一台计算机上运行
- Claude 和 Codex 公开不同的内置功能可见性，因此 Paperclip 不应过度适合一种工具

## 核心产品决策

Paperclip 应该建模**执行工作区**，而不是**工作树**。

更具体地说：

- 持久的锚点是**项目工作区**或回购结帐
- 问题可能会从该项目工作区派生临时的**执行工作区**
- 执行工作区的一种实现是 **git 工作树**
- 适配器决定是否以及如何使用该派生工作区

这使抽象保持可移植性：

- `project workspace` 是仓库/项目级别的概念
- `execution workspace` 是运行时的运行时签出/cwd
- `git worktree` 是创建执行工作区的一种策略
- `workspace runtime services` 是附加到该工作区的长期进程或预览

这也使抽象对非本地适配器有效：

- 本地适配器可能会收到由 Paperclip 生成的真实文件系统 cwd
- 远程或云适配器可以以结构化形式接收相同的执行意图，并在自己的环境中实现它
- Paperclip 不应假设每个适配器都可以直接查看或使用主机文件系统路径

## 主要框架问题的回答

### 工作树是用于智能体还是用于存储库/项目？

它们应该被视为**存储库/项目范围的基础设施**，而不是智能体身份。

稳定的对象是项目工作区。智能体人来来去去，所有权发生变化，同一个问题可能会被重新分配。 git 工作树是针对特定任务或问题的存储库工作区的派生签出。智能体使用它，但不应该拥有该抽象。

如果 Paperclip 使工作树智能体优先，它将变得模糊：- 智能体主目录
- 项目回购根源
- 特定问题的分支/结账

这使得重用、重新分配、清理和 UI 可见性变得更加困难。

### 我们如何保留选择性？

通过使执行工作区策略**在适配器/配置层**选择加入**，而不是全局不变量。

应保留默认值：

- 现有项目工作空间分辨率
- 现有任务会话简历
- 现有智能体主页后备

然后本地编码智能体可以选择类似 `git_worktree` 的策略。

### 我们如何使其便携且适用于适配器？

通过职责划分：

- Paperclip 核心解析并记录执行工作区状态
- 共享的本地运行时助手可以实现基于 git 的结帐策略
- 每个适配器使用特定于适配器的标志在解析的 cwd 中启动其工具

这可以避免将 Claude 形状或 Codex 形状的模型强制安装到所有适配器上。

它还避免将主机文件系统模型强制到云智能体上。云适配器可以将相同请求的策略解释为：

- 从 repo + ref 创建一个新的沙箱结账
- 在提供商的远程环境中创建一个独立的分支/工作区
- 忽略仅本地字段，如主机 cwd，同时仍然尊重分支/引用/隔离意图

## 产品和用户体验要求

当前的技术模型方向是正确的，但产品表面需要更清晰地分离：

- **执行工作空间**的通用跨适配器概念
- **孤立问题检查**的用户可见的 local-git 实现概念
- **git 工作树** 的具体 git 实现细节

这些不应折叠到 UI 中的一个标签中。

### 术语推荐

对于产品/UI 副本：

- 使用**执行工作空间**来实现通用跨适配器概念
- 当我们想说“这个问题有自己的分支/结帐”时，使用**隔离问题结帐**作为面向用户的功能
- 保留**git worktree**用于高级或实施细节视图

这为 Paperclip 提供了支持的空间：

- 本地 git 工作树
- 远程沙箱结账
- 适配器管理的远程工作空间

没有教导用户“工作区”始终意味着“我的机器上的 git worktree”。

### 项目级默认值应该驱动该功能

应该配置的主要位置是**项目**，而不是智能体表单。

推理：

- 存储库/项目是否需要孤立的问题检查主要是项目工作流程决策
- 大多数操作员不希望为每个智能体配置运行时 JSON
- 智能体应继承项目的工作区策略，除非存在强大的特定于适配器的覆盖
- 董事会需要一个地方来表达回购工作流程默认值，例如分支、PR、清理和预览生命周期

因此该项目应该拥有如下设置：- `isolatedIssueCheckouts.enabled` 或同等学历

这应该是该项目中新问题的默认驱动程序。

### 问题级别的使用应该保持可选

即使项目支持孤立的问题检查，也不应该将每个问题强制合并为一个。

示例：

- 在主项目工作区中进行一个小修复可能就可以了
- 操作员可能希望直接在长期存在的分支上工作
- 董事会用户可能希望创建一个任务而不支付设置/清理开销

所以模型应该是：

- 项目定义孤立问题检查是否可用以及默认值是什么
- 每个问题在创建时都可以选择加入或退出
- 默认问题值可以从项目继承

这不需要在正常问题创建流程中显示高级适配器配置。

### 运行时服务通常应该在智能体表单中隐藏

当前的原始运行时服务 JSON 作为大多数本地智能体的主要 UI 级别太低。

对于 `claude_local` 和 `codex_local`，可能期望的行为是：

- Paperclip 使用项目/工作空间策略在后台处理工作空间运行时服务
- 运营商不需要以智能体形式手工编写通用运行时JSON
- 如果特定于提供者的适配器稍后需要更丰富的运行时配置，请为其提供专用的 UI，而不是默认的通用 JSON

所以UI推荐是：

- 将运行时服务 JSON 排除在默认的本地智能体编辑体验之外
- 仅允许在高级部分或适配器特定的专家模式后面使用
- 将通用工作流程设置移至项目级工作区自动化设置

### 拉取请求工作流程需要明确的所有权和批准规则

一旦 Paperclip 创建孤立的问题检查，它就隐式地触及了更大的工作流程：

- 分支创建
- 运行时服务启动/停止
- 提交并推送
- PR创作
- 合并或放弃后的清理

这意味着该产品需要一个明确的模型来说明**谁拥有 PR 创建和合并准备情况**。

至少有两种有效模式：

- 智能体管理的PR创建
- PR创建需经过批准

可能有三个不同的决策点：

1. 智能体应该自动提交吗？
2. 智能体是否应该自动打开PR？
3. 开放或标记就绪是否需要董事会批准？

这些不应被隐藏在适配器提示中。它们是工作流程规则。

### 人工操作工作流程与问题隔离工作流程不同

人类操作员可能想要一个长期存在的个人集成分支，例如 `dotta`，并且可能不希望每个任务都创建一个新的分支/工作空间舞蹈。

这是一个合法的工作流程，应该直接支持。

所以Paperclip应该区分：- **隔离问题检查工作流程**：针对智能体并行性和问题范围隔离进行了优化
- **个人分支工作流程**：针对人员或操作员进行优化，在长期分支上进行多项相关更改，并在方便时将 PR 创建回主分支

这意味着：

- 即使可用，孤立的问题检查也应该是可选的
- 项目工作流程设置应支持“直接使用基础分支”或“使用首选操作员分支”路径
- PR 政策不应假设每个工作单元 1:1 映射到新分支或 PR

## 推荐的用户体验模型

### 1. 项目级“执行工作空间”设置

项目应该有一个用于工作区自动化的专用设置区域。

建议结构：

- `Execution Workspaces`
  - `Enable isolated issue checkouts`
  - `Default for new issues`
  - `Checkout implementation`
  - `Branch and PR behavior`
  - `Runtime services`
  - `Cleanup behavior`

对于本地 git 支持的项目，可见语言可以更具体：

- `Enable isolated issue checkouts`
- `Implementation: Git worktree`

对于远程或适配器管理的项目，同一部分可以改为：

- `Implementation: Adapter-managed workspace`

### 2.问题创建应该公开一个简单的选择加入

在启用了执行工作区支持的项目内创建问题时：

- 显示复选框或切换开关，例如 `Use isolated issue checkout`
- 从项目设置中默认它
- 隐藏高级工作区控件，除非操作员扩展了高级部分

如果项目不支持执行工作区，则根本不显示控件。

这会在保留控制的同时保持默认的 UI 灯光。

### 3.智能体配置应该主要基于继承

智能体表单不应成为操作员为常见本地智能体组装工作树/运行时策略的主要位置。

相反：

- 本地编码智能体继承项目的执行工作空间策略
- 智能体表单仅在真正必要时才公开覆盖
- 原始 JSON 配置仅适用于高级

这意味着常见情况变为：

- 配置项目一次
- 指定本地编码智能体
- 与可选的隔离结帐行为产生问题

### 4. 高级实现细节仍然存在

高级用户仍应有一个高级视图，显示：

- 执行工作区策略有效负载
- 运行时服务意图有效负载
- 特定于适配器的覆盖

但这应该被视为专家/调试界面，而不是默认的心理模型。

## 推荐的工作流程策略模型

### 工作空间实现政策

建议的策略值：

- `shared_project_workspace`
- `isolated_issue_checkout`
- `adapter_managed_isolated_workspace`

对于本地 git 项目，`isolated_issue_checkout` 可能映射到 `git_worktree`。

### 分行政策

建议的项目级分支政策领域：

- `baseBranch`
- `branchMode`: `issue_scoped | operator_branch | project_primary`
- `branchTemplate` 用于问题范围的分支
- `operatorPreferredBranch` 用于人类/操作员工作流程

这允许：- 严格智能体发行分支机构
- 人类长寿的个人分支
- 需要时直接使用项目主工作区

### 拉取请求策略

建议的项目级PR政策领域：

- `prMode`: `none | agent_may_open | agent_auto_open | approval_required`
- `autoPushOnDone`：布尔值
- `requireApprovalBeforeOpen`：布尔值
- `requireApprovalBeforeReady`：布尔值
- `defaultBaseBranch`

这使得PR行为变得明确且可控。

### 清理政策

建议的项目级清理字段：

- `stopRuntimeServicesOnDone`
- `removeIsolatedCheckoutOnDone`
- `removeIsolatedCheckoutOnMerged`
- `deleteIssueBranchOnMerged`
- `retainFailedWorkspaceForInspection`

这些很重要，因为工作区自动化不仅仅是设置。清理路径是产品的一部分。

## 针对当前UI问题的设计建议

基于上述问题，UI 应按以下方式进行更改：

### 智能体用户界面

- 从默认的本地智能体配置界面中删除通用运行时服务 JSON
- 仅将原始工作区/运行时 JSON 保留在高级设置后面
- 更喜欢从 `claude_local` 和 `codex_local` 的项目设置继承
- 仅当适配器确实需要 Paperclip 无法推断的设置时才添加特定于适配器的运行时 UI

### 项目用户界面

- 添加项目级执行工作区设置部分
- 允许为该项目启用孤立的问题检查
- 在那里存储默认问题行为
- 公开分支、PR、运行时服务和清理默认值

### 问题创建 UI

- 仅当项目启用了执行工作区支持时才显示 `Use isolated issue checkout`
- 将其保留为问题级别的选择加入/退出，默认为项目
- 除非有要求，否则隐藏高级执行工作区详细信息

## 对规范的影响

这以一种有用的方式改变了计划的重点：

- 项目成为主要工作流程配置所有者
- 该问题成为独立结账行为选择加入/退出的单位
- 智能体成为执行者，通常继承工作流程规则
- 原始运行时 JSON 成为高级/内部表示，而不是主要 UX

它还澄清了 PR 创建和清理不是可选的旁注。它们是工作区自动化产品表面的核心部分。

## 具体集成清单

本节将上述产品需求转化为当前代码库的具体实施计划。

### 指导优先规则

运行时决策顺序应变为：

1. 问题级执行工作区覆盖
2. 项目级执行工作区策略
3. 智能体级适配器覆盖
4. 当前默认行为

这是关键的架构变化。如今，对于所需的用户体验来说，实现过于以智能体配置为中心。

## 建议的字段名称

### 项目级字段

添加项目拥有的执行工作区策略对象。建议共享形状：

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

注意事项：- `enabled` 控制项目是否公开孤立问题检查行为
- `defaultMode` 控制问题创建默认值
- `implementation` 对于本地或远程适配器来说足够通用
- 运行时服务配置嵌套在此处，而不是默认智能体形式

### 问题级别字段

添加问题所属的选择加入/覆盖字段。建议形状：

```ts
type IssueExecutionWorkspaceSettings = {
  mode?: "inherit_project_default" | "shared_project_workspace" | "isolated_issue_checkout";
  branchOverride?: string | null;
  pullRequestModeOverride?: "inherit" | "none" | "agent_may_open" | "agent_auto_open" | "approval_required";
};
```

这通常应该隐藏在简单的 UI 后面：

- 像 `Use isolated issue checkout` 这样的复选框
- 仅在需要时进行高级控制

### 智能体级别字段

保留智能体级工作区/运行时配置，但仅将其重新定位为高级覆盖。

建议的语义：

- 如果缺席，继承项目+发布政策
- 如果存在，仅覆盖该适配器所需的实现细节

## 共享类型和 API 更改

### 1. 共享项目类型

首先要更改的文件：

- `packages/shared/src/types/project.ts`
- `packages/shared/src/validators/project.ts`

添加：

- `executionWorkspacePolicy?: ProjectExecutionWorkspacePolicy | null`

### 2. 共享问题类型

要更改的文件：

- `packages/shared/src/types/issue.ts`
- `packages/shared/src/validators/issue.ts`

添加：

- `executionWorkspaceSettings?: IssueExecutionWorkspaceSettings | null`

### 3.数据库模式

如果我们希望这些字段直接保留在现有实体上，而不是存在于不透明的 JSON 中：

- `packages/db/src/schema/projects.ts`
- `packages/db/src/schema/issues.ts`
- `packages/db/src/migrations/` 中的迁移生成

推荐第一剪：

- 在 `projects` 上将项目策略存储为 JSONB
- 将问题设置覆盖存储为 `issues` 上的 JSONB

当产品模型仍在移动时，这可以最大限度地减少模式改动。

建议栏目：

- `projects.execution_workspace_policy jsonb`
- `issues.execution_workspace_settings jsonb`

## 服务器端分辨率更改

### 4.项目服务读/写路径

文件：

- `server/src/services/projects.ts`
- `server/src/routes/projects.ts`的项目路线

任务：

- 接受并验证项目执行工作空间政策
- 从项目 API 有效负载返回它
- 照常执行公司范围界定

### 5. 发布服务创建/更新路径

文件：

- `server/src/services/issues.ts`
- `server/src/routes/issues.ts`

任务：

- 接受问题级别 `executionWorkspaceSettings`
- 在启用执行工作区的项目中创建问题时，如果未明确提供，则默认项目策略中的问题设置
- 对于普通客户端来说，保持问题有效负载简单；高级字段可以是可选的

### 6. 心跳和运行分辨率

主文件：

- `server/src/services/heartbeat.ts`

应重构当前行为，以便工作区解析基于：

- 问题设置
- 然后是项目政策
- 然后适配器覆盖

具体技术工作：

- 在运行解析期间加载项目执行工作区策略
- 在运行解决期间加载问题执行工作区设置
- 在适配器启动之前导出有效的执行工作空间决策对象
- 仅将适配器配置保留为覆盖

建议的内部助手：

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

## 用户界面更改

### 7. 项目设置 UI

可能的文件：- `ui/src/components/ProjectProperties.tsx`
- `ui/src/pages/` 下的项目详细信息/设置页面
- `ui/src/api/projects.ts` 中的项目 API 客户端

添加项目拥有的部分：

- `Execution Workspaces`
  - 启用孤立问题检查
  - 新问题的默认设置
  - 实施类型
  - 分支设置
  - PR设置
  - 清理设置
  - 运行时服务默认值

重要的用户体验规则：

- 运行时服务配置不应默认为原始 JSON
- 如果第一次剪辑必须在内部使用 JSON，请将其包装在最小的结构化形式或高级披露中

### 8.问题创建/编辑 UI

可能的文件：

- 在 `ui/src/pages/` 中创建 UI 组件并发布详细编辑界面
- 在`ui/src/api/issues.ts`中发布API客户端

添加：

- `Use isolated issue checkout` 切换，仅当项目策略启用时
- 高级工作区行为仅在展开时进行控制

不显示：

- 原始运行时服务 JSON
- 原始策略有效负载

在默认问题创建流程中。

### 9. 智能体 UI 清理

文件：

- `ui/src/adapters/local-workspace-runtime-fields.tsx`
- `ui/src/adapters/codex-local/config-fields.tsx`
- `ui/src/adapters/claude-local/config-fields.tsx`

技术方向：

- 保留现有的配置表面作为高级覆盖
- 将其从本地编码智能体的默认表单流程中删除
- 添加解释性副本，说明项目执行工作区策略将被继承，除非被覆盖

## 适配器和编排更改

### 10. 本地适配器行为

文件：

- `packages/adapters/codex-local/src/ui/build-config.ts`
- `packages/adapters/claude-local/src/ui/build-config.ts`
- 本地适配器执行路径已消耗 env/context

任务：

- 继续从心跳接受已解析的工作区/运行时上下文
- 停止假设智能体配置是工作区策略的主要来源
- 保留特定于适配器的覆盖支持

### 11.运行时服务编排

文件：

- `server/src/services/workspace-runtime.ts`

任务：

- 接受有效项目/问题策略中的运行时服务默认值
- 将适配器配置运行时服务 JSON 保留为仅覆盖
- 保留远程适配器的可移植性

## 拉取请求和清理工作流程

### 12.PR政策执行

目前这尚未完全实现，应将其视为单独的编排层。

可能的文件：

- `server/src/services/heartbeat.ts`
- 未来的 git/provider 集成助手

需要做出的决定：

- 当问题完成时，Paperclip 应该自动提交吗？
- 它应该自动推送吗？
- 它应该自动打开 PR 吗？
- PR开放/准备就绪是否应该经过批准？

建议的方法：

- 存储项目的PR政策
- 解决每个问题/运行的有效PR政策
- 发出明确的工作流程操作，而不是仅仅依赖提示文本

### 13.清理策略执行

可能的文件：

- `server/src/services/workspace-runtime.ts`
- `server/src/services/heartbeat.ts`
- 任何未来的合并检测挂钩

需要的行为：

- 完成或合并时停止运行时服务
- 删除完成或合并时的单独结账
- 如果政策如此规定，则删除合并后的分支
- 可选择保留失败的工作空间以供检查## 建议的第一个实施顺序

要在不破坏系统稳定性的情况下整合这些想法，请按以下顺序实施：

1. 将项目策略字段添加到共享类型、验证器、数据库、服务、路由和项目 UI。
2. 将问题级执行工作区设置字段添加到共享类型、验证器、数据库、服务、路由和问题创建/编辑 UI。
3. 重构心跳以从问题 -> 项目 -> 智能体覆盖中计算有效的执行工作区策略。
4. 更改本地智能体 UI，使工作区/运行时 JSON 变为仅限高级。
5. 将默认运行时服务行为移至项目设置。
6. 添加显式PR策略存储和解析。
7. 添加显式清理策略存储和解析。

## 此产品转换完成的定义

当所有条件都成立时，此设计转变就完成了：

- 项目设置拥有默认工作区策略
- 问题创建公开了一个简单的选择加入/退出（如果可用）
- 对于常见情况，本地智能体表单不再需要原始运行时 JSON
- 心跳解决了项目+问题+覆盖优先级的有效工作空间行为
- PR 和清理行为被建模为明确的策略，而不是隐含的提示行为
- UI 语言将执行工作区与本地 git 工作树实现细节区分开来

## 当前代码已经支持什么

Paperclip 已经具备了项目优先模型的正确基础。

### 项目工作区已经是一流的

- `project_workspaces` 已存在于 `packages/db/src/schema/project_workspaces.ts` 中
- 共享的 `ProjectWorkspace` 类型已包含 `packages/shared/src/types/project.ts` 中的 `cwd`、`repoUrl` 和 `repoRef`
- 文档已经声明智能体使用项目的主工作区来执行 `docs/api/goals-and-projects.md` 中的项目范围任务

### Heartbeat 已按正确的顺序解析工作空间

当前的运行分辨率已经首选：

1. 项目工作区
2. 之前的任务会话cwd
3. 智能体-home 后备

参见 `server/src/services/heartbeat.ts`。

### 会话恢复已支持 cwd

两个本地编码适配器都将会话连续性视为受 cwd 限制：

- Codex: `packages/adapters/codex-local/src/server/execute.ts`
- Claude: `packages/adapters/claude-local/src/server/execute.ts`

这意味着干净的插入点是在适配器执行之前：首先解析最终执行cwd，然后让适配器正常运行。

### 服务器生成的本地身份验证已存在

对于服务器生成的本地适配器，Paperclip 已经注入了一个短暂的本地 JWT：

- JWT 创建：`server/src/services/heartbeat.ts`
- 适配器环境注入：
  - `packages/adapters/codex-local/src/server/execute.ts`
  - `packages/adapters/claude-local/src/server/execute.ts`

在身份验证模式下，手动本地引导路径仍然较弱，但这是一个相关的身份验证人体工程学问题，而不是使工作树成为核心不变量的原因。

## 来自供应商文档的工具观察

链接的工具文档支持项目优先、特定于适配器的启动模型。

### Codex- Codex 应用程序具有用于 git 存储库中并行任务的本机工作树概念
- Codex CLI 文档在选定的工作目录中运行并从当前工作目录恢复会话
- Codex CLI 不提供 Paperclip 应该直接镜像的单个一流可移植 CLI 工作树抽象

含义：

- 对于 `codex_local`，Paperclip 通常应创建/选择结帐本身，然后在该 cwd 内启动 Codex

### Claude

- Claude 记录并行会话的显式 git worktree 工作流程
- Claude CLI 支持 `--worktree` / `-w`
- Claude 会话也仍然与目录上下文相关

含义：

- `claude_local` 可以选择使用原生 `--worktree`
- 但 Paperclip 仍应将其视为适配器优化，而不是规范的跨适配器模型

## 本地适配器与远程适配器

该计划必须明确考虑到许多适配器不是本地的这一事实。

示例：

- 本地 CLI 适配器，例如 `codex_local` 和 `claude_local`
- 云托管编码智能体，例如 Cursor 云智能体
- 未来托管Codex或Claude智能体模式
- 基于 E2B、Cloudflare 或类似环境构建的自定义沙箱适配器

这些适配器并不都具有相同的功能：

- 有些可以直接使用主机 git worktrees
- 有些可以远程克隆存储库并创建分支
- 有些可能会暴露虚拟工作空间概念，而没有直接的 git worktree 等效项
- 有些可能根本不允许持久文件系统状态

因此，Paperclip 应该分开：

- **执行工作区意图**：我们想要什么隔离/分支/存储库行为
- **适配器实现**：特定适配器如何实现该行为

### 执行工作区意图

Paperclip 应该能够表达诸如以下的意图：

- 直接使用项目的主工作区
- 创建一个孤立的问题范围结账
- 基于给定存储库参考的基础工作
- 从问题中获取分支名称
- 如果启动运行时服务，则公开一个或多个可访问的预览或服务 URL

### 适配器实现

适配器应该可以自由地将意图映射到自己的环境中：

- 本地适配器：创建主机 git worktree 并在该 cwd 中运行
- 云沙箱适配器：将存储库克隆到沙箱中，在那里创建分支，并返回沙箱元数据
- 托管远程编码智能体：调用提供者 APIs，创建绑定到请求的分支/引用的远程工作区/线程

重要的约束是适配器以规范化的形式报告已实现的执行工作空间元数据，即使底层实现不是 git 工作树。

## 建议模型

使用三层：1.`project workspace`
2. `execution workspace`
3. `workspace runtime services`
4. `adapter session`

### 1. 项目工作区

长寿的回购锚。

示例：

- `./paperclip`
- 存储库 URL 和基本参考
- 项目的初步检查

### 2. 执行工作区

针对特定问题/运行的派生运行时检查。

示例：

- 直接使用项目主工作区
- 从项目工作区派生的 git worktree
- 从存储库 URL + ref 派生的远程沙箱结帐
- 由适配器特定脚本生成的自定义结账

### 3.适配器会话

与工作空间关联的长寿命或半长寿命进程。

示例：

- 本地网络服务器
- 后台工作者
- 沙箱预览 URL
- 测试观察者
- 隧道工艺

这些并不是 Paperclip 特有的。它们是在开发工作区（无论是本地还是远程）中工作的常见属性。

### 4. 适配器会话

Claude/Codex 会话连续性和运行时状态，保持 cwd 感知，并且应该遵循执行工作空间而不是定义它。

## 推荐配置面

在适配器配置中引入通用执行工作区策略。

形状示例：

```json
{
  "workspaceStrategy": {
    "type": "project_primary"
  }
}
```

或者：

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

远程适配器可以使用如下形状：

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

重要的一点是，`git_worktree`是可以使用它的适配器的策略值，而不是通用合约。

### 工作区运行时服务

不要将其建模为 Paperclip 特定的 `devServer` 标志。

相反，将其建模为工作区附加的运行时服务的通用列表。

形状示例：

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

本合同故意是通用的：

- `command` 可以启动任何工作区附加进程，而不仅仅是 Web 服务器
- 数据库重用是通过 env/config 注入来处理的，而不是特定于产品的特殊情况
- 本地和远程适配器可以以不同的方式实现相同的服务意图

### 服务意图与服务实现

Paperclip 应区分：

- **服务意图**：工作区需要什么样的配套运行时
- **服务实现**：本地或远程适配器如何实际启动并公开它

示例：

- 本地适配器：
  - 开始 `pnpm dev`
  - 分配一个空闲的主机端口
  - 健康检查本地主机 URL
  - 报告 `{ pid, port, url }`
- 云沙箱适配器：
  - 在沙箱内启动预览过程
  - 接收提供者预览 URL
  - 报告 `{ sandboxId, previewUrl }`
- 托管远程编码智能体：
  - 可能会要求提供商创建预览环境
  - 报告提供者本机工作区/服务元数据

Paperclip 应该规范报告的元数据，而不要求每个适配器看起来像主机本地进程。

通过 `packages/shared/src/types/issue.ts` 中现有的 `assigneeAdapterOverrides` 形状保持问题级别覆盖成为可能。

## 分层职责

### Paperclip 核心Paperclip 核心应该：

- 解决基础项目工作区的问题
- 解析或请求执行工作空间
- 配置后解析或请求工作区运行时服务
- 将执行工作区元数据注入运行上下文
- 保留足够的元数据以供板可见性和清理
- 在需要时管理运行开始/结束的生命周期挂钩

Paperclip 核心不应：

- 需要所有智能体的工作树
- 假设每个适配器都是本地的并且由 git 支持
- 假设每个运行时服务都是具有 PID 的本地主机进程
- 将特定于工具的工作树提示编码为核心产品行为

### 共享本地运行时助手

共享服务器端助手应该处理本地 git 机制：

- 验证仓库根
- 创建/选择分支
- 创建/选择 git 工作树
- 分配一个空闲端口
- 可选择启动并跟踪开发服务器
- 返回`{ cwd, branchName, url }`

该助手可以通过以下方式重用：

- `codex_local`
- `claude_local`
- 未来的本地适配器，例如 Cursor/OpenCode 等效项

该帮助程序仅适用于本地适配器。不应通过主机本地 git 帮助程序强制远程适配器。

### 共享运行时服务管理器

除了本地 git 助手之外，Paperclip 还应该定义一个通用的运行时服务管理器合约。

它的工作是：

- 决定是否应重用已配置的服务或重新启动
- 在需要时分配本地端口
- 当适配器/运行时实现是主机本地时启动并监视本地进程
- 记录标准化服务元数据以用于远程实现
- 运行准备情况检查
- 向董事会提供服务 URL 和状态
- 应用关闭政策

该管理器不应硬编码为“开发服务器”。它应该适用于任何长期存在的工作区伴随进程。

### 适配器

适配器应该：

- 接受已解析的执行cwd
- 或在没有可用的主机 cwd 时接受结构化执行工作区意图
- 当服务编排委托给适配器时接受结构化工作区运行时服务意图
- 使用特定于适配器的标志启动其工具
- 保持自己的会话连续性语义

例如：

- `codex_local`：在cwd内运行，可能与`--cd`或进程cwd一起运行
- `claude_local`：在cwd内运行，如果有帮助，可以选择使用`--worktree`
- 远程沙箱适配器：从 repo/ref/branch 意图创建自己的隔离工作区，并将实现的远程工作区元数据报告回 Paperclip

对于运行时服务：

- 本地适配器或共享主机管理器：启动本地进程并返回主机本地元数据
- 远程适配器：创建或重用远程预览/服务并返回规范化的远程元数据

## 添加最少的数据模型

暂时不要创建完全一流的 `worktrees` 表。通过记录有关运行、问题或两者的派生执行工作区元数据，从小规模开始。

建议引入的领域：

- `executionWorkspaceStrategy`
- `executionWorkspaceCwd`
- `executionBranchName`
- `executionWorkspaceStatus`
- `executionServiceRefs`
- `executionCleanupStatus`

这些可以首先存在于 `heartbeat_runs.context_snapshot` 或相邻的运行元数据上，如果 UI 和清理工作流程证明合理，则可以选择稍后移至专用表中。

特别是对于运行时服务，Paperclip 最终应该跟踪规范化字段，例如：

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

如果需要，第一个实现可以将其保留在运行元数据中，但长期形状是通用运行时服务注册表，而不是一次性服务器 URL 字段。

## 具体实施方案

## 第一阶段：定义共享合约

1、在`packages/shared`中引入共享执行工作空间策略合约。
2. 添加适配器配置架构支持：
   - `workspaceStrategy.type`
   - `baseRef`
   - `branchTemplate`
   - `worktreeParentDir`
   - `cleanupPolicy`
   - 可选的工作区运行时服务设置
3. 保持现有的 `useProjectWorkspace` 标志作为较低级别的兼容性控制。
4. 将本地实现字段与通用意图字段区分开，以便远程适配器不会被迫使用主机 cwd 值。
5. 定义通用 `workspaceRuntime.services[]` 合约：
   - 服务名称
   - 命令或提供者管理的意图
   - 环境覆盖
   - 准备情况检查
   - 曝光元数据
   - 重用范围
   - 生命周期
   - 停止政策

验收：

- 适配器配置可以表示`project_primary`和`git_worktree`
- 配置仍然是可选的并且向后兼容
- 运行时服务一般表示，而不是 Paperclip-only 开发服务器标志

## 第 2 阶段：解决 Heartbeat 中的执行工作空间

1. 扩展心跳工作区分辨率，使其能够返回更丰富的执行工作区结果。
2. 保持当前的后备顺序，但区分：
   - 基础项目工作区
   - 派生执行工作空间
3. 将解析的执行工作空间详细信息注入到本地适配器的 `context.paperclipWorkspace` 中，以及需要结构化远程实现的适配器的通用执行工作空间意图负载中。
4. 与执行工作区一起解析配置的运行时服务意图，以便适配器或主机管理器接收完整的工作区运行时合同。

主要接触点：

- `server/src/services/heartbeat.ts`

验收：

- 未配置策略时，运行仍保持不变
- 已解决的上下文清楚地表明哪个策略产生了 CWD

## 第 3 阶段：添加共享本地 Git 工作区助手1. 为本地存储库签出策略创建服务器端帮助程序模块。
2、实施`git_worktree`策略：
   - 在基础工作区 cwd 验证 git 存储库
   - 从问题中获取分支名称
   - 创建或重用工作树路径
   - 干净地检测碰撞
3. 返回结构化元数据：
   - 最终的CWD
   - 分行名称
   - 工作树路径
   - 回购根

验收：

- 助手可以在单个适配器之外重复使用
- 工作树的创建对于给定的问题/配置是确定性的
- 远程适配器不受此帮助程序的影响

## 第 4 阶段：可选的开发服务器生命周期

从概念上讲，将此阶段重命名为 **工作区运行时服务生命周期**。

1. 在创建执行工作区时添加可选的运行时服务启动。
2. 同时支持：
   - 主机管理的本地服务
   - 适配器管理的远程服务
3. 对于本地服务：
   - 在需要时在启动前分配一个空闲端口
   - 在正确的cwd中启动配置的命令
   - 运行准备情况检查
   - 注册已实现的元数据
4. 对于远程服务：
   - 让适配器在配置后返回规范化的服务元数据
   - 不假设 PID 或本地主机访问
5. 使用服务 URL 和标签发布或更新问题可见元数据。

验收：

- 运行时服务启动仍然是选择加入
- 失败产生可操作的运行日志并发出评论
- 适当时可以通过 env/config 注入重用相同的嵌入式 DB / Paperclip 实例
- 远程服务实现无需假装是本地进程即可表示

## 第 5 阶段：运行时服务重用、跟踪和关闭1.引入通用运行时服务注册中心。
2. 应跟踪每项服务：
   - `scopeType`: `project_workspace | execution_workspace | run | agent`
   - `scopeId`
   - `serviceName`
   - `status`
   - `command` 或提供商元数据
   - `cwd`（如果是本地）
   - `envFingerprint`
   - `port`
   - `url`
   - `provider` / `providerRef`
   - `ownerAgentId`
   - `startedByRunId`
   - `lastUsedAt`
   - `stopPolicy`
3. 引入一个确定性的`reuseKey`，例如：
   - `projectWorkspaceId + serviceName + envFingerprint`
4. 重复使用政策：
   - 如果存在具有相同重用密钥的健康服务，则附加到它
   - 否则启动新服务
5. 区分生命周期类：
   - `shared`：可跨运行重用，通常范围为 `project_workspace`
   - `ephemeral`：绑定到 `execution_workspace` 或 `run`
6. 停工政策：
   - `run`范围：运行结束时停止
   - `execution_workspace` 范围：清理工作区时停止
   - `project_workspace` 范围：空闲超时、显式停止或工作区删除时停止
   - `agent` 范围：所有权转让或智能体政策要求时停止
7. 卫生政策：
   - 启动时的准备情况检查
   - 定期或按需活性检查
   - 尽可能在杀死前标记不健康

验收：

- Paperclip 可以确定性地决定是否重用或启动新服务
- 本地和远程服务共享标准化的跟踪模型
- 关闭是政策驱动的而不是隐性的
- 董事会可以理解为什么服务被保留、重用或停止

## 第 6 阶段：适配器集成

1. 更新 `codex_local` 以使用已解析的执行工作区 cwd。
2. 更新 `claude_local` 以使用已解析的执行工作区 cwd。
3. 为接收执行工作区意图而不是主机本地 cwd 的远程适配器定义规范化适配器协定。
4. 有选择地允许使用本机 `--worktree` 的 Claude 特定优化路径，但保持共享服务器端签出策略作为本地适配器的规范。
5. 定义适配器如何返回运行时服务实现：
   - 本地主机管理服务参考
   - 远程提供商管理的服务参考

验收：

- 当策略不存在时，适配器行为保持不变
- 会话恢复仍然是 CWD 安全的
- 没有适配器被强制进入 git 行为
- 远程适配器可以实现等效隔离，而无需假装是本地工作树
- 适配器可以以规范化的形式报告服务 URL 和生命周期元数据

## 第 7 阶段：可见性和问题评论1. 在运行详细信息中公开执行工作区元数据，并可选择发出详细信息 UI：
   - 策略
   - CWD
   - 分支机构
   - 运行时服务参考
2. 通过以下方式公开运行时服务：
   - 服务名称
   - 状态
   - 网址
   - 范围
   - 业主
   - 健康
3. 当工作树支持或远程隔离运行启动时添加标准问题注释输出：
   - 分支机构
   - 工作树路径
   - 服务 URL（如果存在）

验收：

- 董事会可以看到智能体在哪里工作
- 董事会可以看到该工作区存在哪些运行时服务
- 问题线程成为分支名称和可到达 URL 的交接面

## 第 8 阶段：清理政策

1. 实施清理政策：
   - `manual`
   - `on_done`
   - `on_merged`
2. 对于工作树清理：
   - 如果属于工作空间生命周期，则停止跟踪的运行时服务
   - 删除工作树
   - 合并后可选择删除本地分支
3. 从保守的默认值开始：
   - 除非明确配置，否则不要自动删除任何内容

验收：

- 默认情况下清理是安全且可逆的
- 基本生命周期稳定后可以引入基于合并的清理

## 第 9 阶段：验证人体工程学后续行动

这是相关的，但应与工作区策略工作分开跟踪。

需要改进：

- 使手动本地智能体引导在身份验证/私有模式下更容易，因此操作员可以在本地成为 `codexcoder` 或 `claudecoder` ，而无需依赖于已建立的浏览器身份验证 CLI 上下文

这可能应该采取本地操作员引导流程的形式，而不是削弱运行时身份验证边界。

## 推出策略

1. 首先发送共享配置合约和无操作兼容的心跳更改。
2. 仅使用 `codexcoder` 和 `claudecoder` 进行试点。
3. 首先针对 Paperclip-on-Paperclip 工作流程进行测试。
4. 将 `project_primary` 保留为所有现有智能体的默认值。
5. 仅在核心运行时路径稳定后添加UI暴露和清理。

## 验收标准1. 工作树行为是可选的，不是全局要求。
2. 项目工作区仍然是规范的存储库锚点。
3. 本地编码智能体可以选择进入隔离的问题范围执行工作区。
4. 相同的模型适用于 `codex_local` 和 `claude_local`，而无需将特定于工具的抽象强制到核心中。
5. 远程适配器可以使用相同的执行工作区意图，而不需要主机本地文件系统访问。
6. 会话连续性保持正确，因为每个适配器都相对于其实现的执行工作空间恢复。
7. 工作区运行时服务是通用建模的，而不是 Paperclip 特定的开发服务器切换。
8. Board 用户可以查看工作树支持或远程隔离运行的分支/路径/URL 信息。
9. 服务重用和关闭是确定性的和策略驱动的。
10. 默认情况下清理是保守的。

## 建议的初始范围

为了保持这个易于处理，第一次实现应该：

- 仅支持本地编码适配器
- 仅支持 `project_primary` 和 `git_worktree`
- 避免为工作树使用新的专用数据库表
- 从单个主机管理的运行时服务实现路径开始
- 推迟合并驱动的清理自动化，直到证明基本的启动/运行/可见性之后

这足以验证本地产品形状，而不会过早地冻结错误的抽象。

验证后的后续扩展：

- 为适配器管理的隔离结帐定义远程适配器契约
- 添加一个云/沙盒适配器实现路径
- 规范化已实现的元数据，以便本地和远程执行工作空间在 UI 中显示相似
- 将运行时服务注册表从本地主机管理的服务扩展到远程适配器管理的服务