# 任务管理数据模型

Paperclip 中任务跟踪的工作原理参考。描述了各实体、它们之间的关系以及任务生命周期的规则。本文档作为目标模型编写——部分内容已经实现，部分属于规划愿景。

---

## 实体层级

```
Workspace
  Initiatives          (roadmap-level objectives, span quarters)
    Projects           (time-bound deliverables, can span teams)
      Milestones       (stages within a project)
        Issues         (units of work, the core entity)
          Sub-issues   (broken-down work under a parent issue)
```

一切都自上而下流动。一个 Initiative（规划目标）包含多个 Project（项目）；一个 Project 包含多个 Milestone（里程碑）和 Issue（事项）；一个 Issue 可以有多个 Sub-issue（子事项）。每个层级增加更细的粒度。

---

## Issue（事项）— 核心实体

Issue 是最基本的工作单元。

### 字段

| 字段 | 类型 | 必填 | 说明 |
| ------------- | ---------------- | -------- | ----------------------------------------------------------------- |
| `id` | uuid | 是 | 主键 |
| `identifier` | string | 计算生成 | 人类可读标识，例如 `ENG-123`（团队前缀 + 自增编号） |
| `title` | string | 是 | 简短摘要 |
| `description` | text/markdown | 否 | 完整描述，支持 Markdown 格式 |
| `status` | WorkflowState FK | 是 | 默认为团队的默认状态 |
| `priority` | enum (0-4) | 否 | 默认为 0（无优先级），详见优先级章节 |
| `estimate` | number | 否 | 复杂度/规模估算点数 |
| `dueDate` | date | 否 | |
| `teamId` | uuid FK | 是 | 每个 Issue 必须属于且仅属于一个团队 |
| `projectId` | uuid FK | 否 | 每个 Issue 最多关联一个项目 |
| `milestoneId` | uuid FK | 否 | 每个 Issue 最多关联一个里程碑 |
| `assigneeId` | uuid FK | 否 | **单负责人**，详见负责人章节 |
| `creatorId` | uuid FK | 否 | 创建者 |
| `parentId` | uuid FK (self) | 否 | 父事项，用于子事项关系 |
| `goalId` | uuid FK | 否 | 关联的目标 |
| `sortOrder` | float | 否 | 视图内的排序 |
| `createdAt` | timestamp | 是 | |
| `updatedAt` | timestamp | 是 | |
| `startedAt` | timestamp | 计算生成 | Issue 进入"已开始"状态的时间 |
| `completedAt` | timestamp | 计算生成 | Issue 进入"已完成"状态的时间 |
| `cancelledAt` | timestamp | 计算生成 | Issue 进入"已取消"状态的时间 |
| `archivedAt` | timestamp | 否 | 软归档 |

---

## Workflow State（工作流状态）

Issue 的状态**不是**一个简单的枚举值。它是一组团队专属的命名状态，每个状态归属于以下固定的**分类**之一：

| 分类 | 用途 | 示例状态 |
| ------------- | ---------------------------- | ------------------------------- |
| **Triage** | 待分诊，需要审查 | Triage |
| **Backlog** | 已接受，尚未准备就绪 | Backlog, Icebox |
| **Unstarted** | 已就绪但尚未开始 | Todo, Ready |
| **Started** | 进行中的工作 | In Progress, In Review, In QA |
| **Completed** | 已完成 | Done, Shipped |
| **Cancelled** | 已拒绝或已放弃 | Cancelled, Won't Fix, Duplicate |

### 规则

- 每个团队在上述分类内定义自己的工作流状态
- 每个分类至少需要一个状态（Triage 分类除外，可选）
- 可在任意分类下添加自定义状态（例如在 Started 下添加 "In Review"）
- 分类是固定且有序的——可以在分类*内部*重排状态，但不能重排分类本身
- 新建 Issue 默认处于团队的第一个 Backlog 状态
- 将 Issue 移动到 Started 分类的状态时，自动设置 `startedAt`；移动到 Completed 时设置 `completedAt`；移动到 Cancelled 时设置 `cancelledAt`
- 将 Issue 标记为重复时，自动移至 Cancelled 分类的状态

### WorkflowState 字段

| 字段 | 类型 | 说明 |
| ------------- | ------- | ----------------------------------------------------------------------------- |
| `id` | uuid | |
| `name` | string | 显示名称，例如 "In Review" |
| `type` | enum | 枚举值：`triage`, `backlog`, `unstarted`, `started`, `completed`, `cancelled` |
| `color` | string | 十六进制颜色值 |
| `description` | string | 可选的引导说明文本 |
| `position` | float | 分类内的排序 |
| `teamId` | uuid FK | 每个状态属于一个团队 |

---

## Priority（优先级）

固定的、不可自定义的数字等级：

| 值 | 标签 | 说明 |
| ----- | ----------- | -------------------------------------- |
| 0 | No priority | 默认值，在优先级视图中排序最后 |
| 1 | Urgent | 可能触发即时通知 |
| 2 | High | |
| 3 | Medium | |
| 4 | Low | |

该等级刻意保持精简和固定。如需更细致的分类，请使用标签（Label）而非增加更多优先级等级。

---

## Team（团队）

团队是主要的组织单元。几乎所有内容都以团队为作用域。

| 字段 | 类型 | 说明 |
| ------------- | ------ | -------------------------------------------------------------- |
| `id` | uuid | |
| `name` | string | 例如 "Engineering" |
| `key` | string | 短大写前缀，例如 "ENG"，用于 Issue 标识符 |
| `description` | string | |

### 团队作用域

- 每个 Issue 必须属于且仅属于一个团队
- 工作流状态按团队划分
- 标签可以是团队级别或工作区（Workspace）级别
- 项目可以跨多个团队

在我们的场景中（AI 公司），团队对应职能领域。每个 Agent（智能体）根据角色归属于某个团队。

---

## Project（项目）

项目将 Issue 按具体的、有时间限制的交付物进行分组。项目可以跨多个团队。

| 字段 | 类型 | 说明 |
| ------------- | --------- | ------------------------------------------------------------- |
| `id` | uuid | |
| `name` | string | |
| `description` | text | |
| `summary` | string | 简短描述 |
| `status` | enum | `backlog`, `planned`, `in_progress`, `completed`, `cancelled` |
| `leadId` | uuid FK | 单一负责人，用于责任归属 |
| `startDate` | date | |
| `targetDate` | date | |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

### 规则

- 每个 Issue 最多属于一个项目
- 项目状态**手动**更新（不从 Issue 状态自动推导）
- 项目可以包含文档（规格说明、简报等）作为关联实体

---

## Milestone（里程碑）

里程碑将项目细分为有意义的阶段。

| 字段 | 类型 | 说明 |
| ------------- | ------- | ------------------------------ |
| `id` | uuid | |
| `name` | string | |
| `description` | text | |
| `targetDate` | date | |
| `projectId` | uuid FK | 必须属于且仅属于一个项目 |
| `sortOrder` | float | |

项目内的 Issue 可以选择性地分配到某个里程碑。

---

## Label / Tag（标签）

标签提供分类标注功能。标签存在于两个作用域：

- **工作区标签（Workspace Labels）** —— 可在所有团队中使用
- **团队标签（Team Labels）** —— 仅限特定团队使用

| 字段 | 类型 | 说明 |
| ------------- | -------------- | ------------------------------- |
| `id` | uuid | |
| `name` | string | |
| `color` | string | 十六进制颜色值 |
| `description` | string | 上下文引导说明 |
| `teamId` | uuid FK | 工作区级别的标签该字段为 null |
| `groupId` | uuid FK (self) | 父标签，用于分组 |

### 标签组（Label Groups）

标签可以组织为一级嵌套（标签组 -> 标签）：

- 同一标签组内的标签在 Issue 上是**互斥的**（每个组最多只能应用其中一个标签）
- 标签组不能再包含其他标签组（仅支持一级嵌套）
- 示例：标签组 "Type" 包含标签 "Bug"、"Feature"、"Chore" —— 一个 Issue 最多只能选择其中一个

### Issue-Label 关联表

通过 `issue_labels` 联接表实现多对多关系：

| 字段 | 类型 |
| --------- | ------- |
| `issueId` | uuid FK |
| `labelId` | uuid FK |

---

## Issue Relation / Dependency（事项关系/依赖）

Issue 之间有四种关系类型：

| 类型 | 含义 | 行为 |
| ------------ | -------------------------------- | --------------------------------------------- |
| `related` | 一般关联 | 信息性链接 |
| `blocks` | 当前事项阻塞另一个事项 | 被阻塞的事项显示标记 |
| `blocked_by` | 当前事项被另一个事项阻塞 | `blocks` 的反向关系 |
| `duplicate` | 当前事项与另一个事项重复 | 自动将重复的事项移至 Cancelled 状态 |

### IssueRelation 字段

| 字段 | 类型 | 说明 |
| ---------------- | ------- | ---------------------------------------------- |
| `id` | uuid | |
| `type` | enum | `related`, `blocks`, `blocked_by`, `duplicate` |
| `issueId` | uuid FK | 源事项 |
| `relatedIssueId` | uuid FK | 目标事项 |

### 规则

- 当阻塞方（blocking issue）被解决时，该关系变为信息性的（标记变绿）
- 重复关系是单向的（你标记的是重复项，而非规范项）
- 阻塞关系在系统层面**不具有传递性**（A 阻塞 B，B 阻塞 C，不会自动使 A 阻塞 C）

---

## Assignee（负责人）

**单负责人模型**，这是有意为之的设计。

- 每个 Issue 同一时间最多只有一个负责人
- 这是刻意的选择：清晰的所有权可以防止责任分散
- 对于涉及多人的协作工作，请使用**子事项（Sub-issues）**并分配不同的负责人

在我们的场景中，Agent（智能体）就是负责人。Issue 上的 `assigneeId` 外键指向 `agents` 表。

---

## Sub-issue（子事项）— 父子关系

Issue 支持父子嵌套。

- 在 Issue 上设置 `parentId` 即可使其成为子事项
- 子事项本身也可以有自己的子事项（多级嵌套）
- 子事项在创建时从父事项继承 **Project**（不会追溯修改），但不会继承 Team、Label 或 Assignee

### 自动关闭

- **子事项自动关闭**：当父事项完成时，剩余的子事项自动标记为完成

### 转换

- 已有的 Issue 可以重新设置父级（添加或移除 `parentId`）
- 拥有多个子事项的父事项可以被"提升"为项目

---

## Estimate（估算）

基于点数的估算方式，按团队配置。

### 可用的估算尺度

| 尺度 | 值 |
| ----------- | ------------------------ |
| Exponential | 1, 2, 4, 8, 16 (+32, 64) |

未估算的 Issue 在计算进度/速率时默认为 1 点。

---

## Comment（评论）

| 字段 | 类型 | 说明 |
| ------------ | -------------- | -------------------------- |
| `id` | uuid | |
| `body` | text/markdown | |
| `issueId` | uuid FK | |
| `authorId` | uuid FK | 可以是用户或 Agent |
| `parentId` | uuid FK (self) | 用于线程化回复 |
| `resolvedAt` | timestamp | 如果该线程已被解决 |
| `createdAt` | timestamp | |
| `updatedAt` | timestamp | |

---

## Initiative（规划目标）

最高层级的规划实体。将多个项目组合以服务于一个战略目标。Initiative 有战略负责人，通常以成果/OKR 来衡量，而非简单的"完成/未完成"。

| 字段 | 类型 | 说明 |
| ------------- | ------- | -------------------------------- |
| `id` | uuid | |
| `name` | string | |
| `description` | text | |
| `ownerId` | uuid FK | 单一负责人 |
| `status` | enum | `planned`, `active`, `completed` |
| `targetDate` | date | |

Initiative 与 Project 为多对多关系（通过 `initiative_projects` 关联），并提供跨所有包含项目的进度汇总视图。

---

## Identifier（标识符）

Issue 使用人类可读的标识符：`{TEAM_KEY}-{NUMBER}`

- 团队前缀（Team Key）：每个团队设置的短大写字符串（例如 "ENG"、"DES"）
- 编号（Number）：每个团队内部的自增整数
- 示例：`ENG-123`、`DES-45`、`OPS-7`
- 如果 Issue 在团队之间转移，会获得新的标识符，旧标识符保留在 `previousIdentifiers` 中

这比 UUID 对人类沟通友好得多。人们会说"看一下 ENG-42"而不是"看一下 7f3a..."。

---

## 实体关系

```
Team (1) ----< (many) Issue
Team (1) ----< (many) WorkflowState
Team (1) ----< (many) Label (team-scoped)

Issue (many) >---- (1) WorkflowState
Issue (many) >---- (0..1) Assignee (Agent)
Issue (many) >---- (0..1) Project
Issue (many) >---- (0..1) Milestone
Issue (many) >---- (0..1) Parent Issue
Issue (1) ----< (many) Sub-issues
Issue (many) >---< (many) Labels         (via issue_labels)
Issue (many) >---< (many) Issue Relations (via issue_relations)
Issue (1) ----< (many) Comments

Project (many) >---- (0..1) Lead (Agent)
Project (1) ----< (many) Milestones
Project (1) ----< (many) Issues

Initiative (many) >---< (many) Projects  (via initiative_projects)
Initiative (many) >---- (1) Owner (Agent)
```

---

## 实施优先级

推荐的构建顺序，按价值从高到低排列：

### 高价值

1. **团队（Teams）** —— `teams` 表 + Issue 上的 `teamId` 外键。这是人类可读标识符（`ENG-123`）和团队级工作流状态的基础。大多数其他功能都依赖于团队作用域，因此优先构建。
2. **工作流状态（Workflow States）** —— `workflow_states` 表 + Issue 上的 `stateId` 外键。支持团队自定义工作流和基于分类的状态流转。
3. **标签（Labels）** —— `labels` + `issue_labels` 表。实现分类标注（Bug/Feature/Chore、领域标签等），避免污染状态字段。
4. **事项关系（Issue Relations）** —— `issue_relations` 表。阻塞/被阻塞关系对 Agent 协调至关重要（Agent A 在 Agent B 完成之前无法开始）。
5. **子事项（Sub-issues）** —— `issues` 表上的 `parentId` 自引用外键。使 Agent 能够拆分大型任务。
6. **评论（Comments）** —— `comments` 表。Agent 需要在不覆盖描述的情况下就 Issue 进行沟通。

### 中等价值

7. **状态流转时间戳** —— Issue 上的 `startedAt`、`completedAt`、`cancelledAt`，由工作流状态变更自动设置。可用于速率跟踪和 SLA 度量。

### 较低优先级（后续实施）

8. **里程碑（Milestones）** —— 当项目复杂到需要阶段划分时有用。
9. **规划目标（Initiatives）** —— 当我们有多个项目服务于共同战略目标时有用。
10. **估算（Estimates）** —— 当我们需要度量吞吐量和预测产能时有用。
