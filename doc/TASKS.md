# 任务管理数据模型

本文是 Paperclip 任务跟踪机制的参考文档，描述了各实体、它们之间的关系以及任务生命周期的管理规则。本文作为目标模型编写——其中部分内容已实现，部分为规划中的目标。

---

## 实体层级

```
Workspace
  Initiatives          (路线图级别的目标，跨季度)
    Projects           (有时间限制的可交付成果，可跨团队)
      Milestones       (项目内的阶段)
        Issues         (工作单元，核心实体)
          Sub-issues   (拆解自父 issue 的子工作)
```

所有内容自上而下流动。一个 initiative 包含多个 project；一个 project 包含 milestone 和 issue；一个 issue 可以有子 issue。每一层都增加粒度。

---

## Issues（核心实体）

Issue 是工作的基本单元。

### 字段

| 字段          | 类型             | 必填 | 说明                                                              |
| ------------- | ---------------- | ---- | ----------------------------------------------------------------- |
| `id`          | uuid             | 是   | 主键                                                              |
| `identifier`  | string           | 计算 | 人类可读，例如 `ENG-123`（团队前缀 + 自增编号）                   |
| `title`       | string           | 是   | 简短摘要                                                          |
| `description` | text/markdown    | 否   | 完整描述，支持 markdown                                           |
| `status`      | WorkflowState FK | 是   | 默认为团队的默认状态                                              |
| `priority`    | enum (0-4)       | 否   | 默认为 0（无优先级），参见优先级章节                              |
| `estimate`    | number           | 否   | 复杂度/规模点数                                                   |
| `dueDate`     | date             | 否   |                                                                   |
| `teamId`      | uuid FK          | 是   | 每个 issue 必须属于且只属于一个团队                               |
| `projectId`   | uuid FK          | 否   | 每个 issue 最多关联一个 project                                   |
| `milestoneId` | uuid FK          | 否   | 每个 issue 最多关联一个 milestone                                 |
| `assigneeId`  | uuid FK          | 否   | **单一负责人**，参见负责人章节                                    |
| `creatorId`   | uuid FK          | 否   | 创建者                                                            |
| `parentId`    | uuid FK (self)   | 否   | 父 issue，用于子 issue 关系                                       |
| `goalId`      | uuid FK          | 否   | 关联的目标/goal                                                   |
| `sortOrder`   | float            | 否   | 视图内的排序顺序                                                  |
| `createdAt`   | timestamp        | 是   |                                                                   |
| `updatedAt`   | timestamp        | 是   |                                                                   |
| `startedAt`   | timestamp        | 计算 | issue 进入"已开始"状态的时间                                      |
| `completedAt` | timestamp        | 计算 | issue 进入"已完成"状态的时间                                      |
| `cancelledAt` | timestamp        | 计算 | issue 进入"已取消"状态的时间                                      |
| `archivedAt`  | timestamp        | 否   | 软归档                                                            |

---

## 工作流状态

Issue 的状态**不是**一个扁平的枚举，而是每个团队自定义的一组具名状态，每个状态归属于以下固定**类别**之一：

| 类别          | 用途                         | 示例状态                        |
| ------------- | ---------------------------- | ------------------------------- |
| **Triage**    | 新进，待审查                 | Triage                          |
| **Backlog**   | 已接受，尚未准备好开工       | Backlog, Icebox                 |
| **Unstarted** | 已就绪但尚未开始             | Todo, Ready                     |
| **Started**   | 积极推进中                   | In Progress, In Review, In QA   |
| **Completed** | 已完成                       | Done, Shipped                   |
| **Cancelled** | 已拒绝或已放弃               | Cancelled, Won't Fix, Duplicate |

### 规则

- 每个团队在这些类别内定义自己的工作流状态
- 每个团队每个类别至少需有一个状态（Triage 可选）
- 可在任意类别内添加自定义状态（例如在 Started 下添加 "In Review"）
- 类别固定且有序——可在类别_内部_对状态排序，但不能调整类别本身的顺序
- 新 issue 默认为团队的第一个 Backlog 状态
- 将 issue 移至 Started 状态时自动设置 `startedAt`；移至 Completed 时设置 `completedAt`；移至 Cancelled 时设置 `cancelledAt`
- 将 issue 标记为重复时自动移入 Cancelled 状态

### WorkflowState 字段

| 字段          | 类型    | 说明                                                                          |
| ------------- | ------- | ----------------------------------------------------------------------------- |
| `id`          | uuid    |                                                                               |
| `name`        | string  | 显示名称，例如 "In Review"                                                    |
| `type`        | enum    | 取值之一：`triage`, `backlog`, `unstarted`, `started`, `completed`, `cancelled` |
| `color`       | string  | 十六进制颜色值                                                                |
| `description` | string  | 可选的指导说明文字                                                            |
| `position`    | float   | 类别内的排序顺序                                                              |
| `teamId`      | uuid FK | 每个状态属于一个团队                                                          |

---

## 优先级

固定的、不可自定义的数值量表：

| 值 | 标签        | 说明                                   |
| -- | ----------- | -------------------------------------- |
| 0  | No priority | 默认值。在优先级视图中排在最后         |
| 1  | Urgent      | 可能触发即时通知                       |
| 2  | High        |                                        |
| 3  | Medium      |                                        |
| 4  | Low         |                                        |

该量表有意保持简小且固定。如需进一步分类，请使用标签，而非增加更多优先级层级。

---

## 团队

团队是主要的组织单位，几乎所有内容都在团队范围内进行管理。

| 字段          | 类型   | 说明                                                           |
| ------------- | ------ | -------------------------------------------------------------- |
| `id`          | uuid   |                                                                |
| `name`        | string | 例如 "Engineering"                                             |
| `key`         | string | 简短的大写前缀，例如 "ENG"，用于 issue 标识符                  |
| `description` | string |                                                                |

### 团队范围

- 每个 issue 必须属于且只属于一个团队
- 工作流状态按团队配置
- 标签可以是团队范围或工作区范围
- Project 可跨多个团队

在我们的场景（AI 公司）中，团队对应各职能领域，每个 agent 根据角色归属于相应团队。

---

## Projects

Project 将 issue 归组到一个具体的、有时限的可交付成果中，可跨多个团队。

| 字段          | 类型      | 说明                                                          |
| ------------- | --------- | ------------------------------------------------------------- |
| `id`          | uuid      |                                                               |
| `name`        | string    |                                                               |
| `description` | text      |                                                               |
| `summary`     | string    | 简短概述                                                      |
| `status`      | enum      | `backlog`, `planned`, `in_progress`, `completed`, `cancelled` |
| `leadId`      | uuid FK   | 单一负责人，以便明确问责                                      |
| `startDate`   | date      |                                                               |
| `targetDate`  | date      |                                                               |
| `createdAt`   | timestamp |                                                               |
| `updatedAt`   | timestamp |                                                               |

### 规则

- 每个 issue 最多属于一个 project
- Project 状态**手动**更新（不自动推导自 issue 状态）
- Project 可包含文档（规格说明、简报）作为关联实体

---

## Milestones

Milestone 将 project 细分为有意义的阶段。

| 字段          | 类型    | 说明                           |
| ------------- | ------- | ------------------------------ |
| `id`          | uuid    |                                |
| `name`        | string  |                                |
| `description` | text    |                                |
| `targetDate`  | date    |                                |
| `projectId`   | uuid FK | 归属于且只属于一个 project     |
| `sortOrder`   | float   |                                |

Project 内的 issue 可选择性地分配到某个 milestone。

---

## 标签

标签提供分类打标功能，存在于两个范围：

- **工作区标签** -- 在所有团队中可用
- **团队标签** -- 仅限于特定团队

| 字段          | 类型           | 说明                            |
| ------------- | -------------- | ------------------------------- |
| `id`          | uuid           |                                 |
| `name`        | string         |                                 |
| `color`       | string         | 十六进制颜色值                  |
| `description` | string         | 上下文说明                      |
| `teamId`      | uuid FK        | 工作区级标签时为 null           |
| `groupId`     | uuid FK (self) | 用于分组的父标签                |

### 标签组

标签可组织成一级嵌套结构（组 -> 标签）：

- 同一组内的标签在一个 issue 上**互斥**（每组只能应用一个）
- 组不能包含其他组（仅支持单层嵌套）
- 示例：组 "Type" 包含标签 "Bug"、"Feature"、"Chore"——一个 issue 最多获得其中一个

### Issue-标签关联

通过 `issue_labels` 关联表实现多对多关系：

| 字段      | 类型    |
| --------- | ------- |
| `issueId` | uuid FK |
| `labelId` | uuid FK |

---

## Issue 关系 / 依赖

Issue 之间有四种关系类型：

| 类型         | 含义                             | 行为                                          |
| ------------ | -------------------------------- | --------------------------------------------- |
| `related`    | 一般关联                         | 信息性链接                                    |
| `blocks`     | 此 issue 阻塞另一个              | 被阻塞的 issue 显示标记                       |
| `blocked_by` | 此 issue 被另一个阻塞            | blocks 的反向关系                             |
| `duplicate`  | 此 issue 与另一个重复            | 自动将重复 issue 移入 Cancelled 状态          |

### IssueRelation 字段

| 字段             | 类型    | 说明                                           |
| ---------------- | ------- | ---------------------------------------------- |
| `id`             | uuid    |                                                |
| `type`           | enum    | `related`, `blocks`, `blocked_by`, `duplicate` |
| `issueId`        | uuid FK | 源 issue                                       |
| `relatedIssueId` | uuid FK | 目标 issue                                     |

### 规则

- 当阻塞 issue 被解决后，该关系变为信息性关系（标记变为绿色）
- 重复关系是单向的（你标记重复方，而非原始方）
- 阻塞关系在系统层面**不具有传递性**（A 阻塞 B，B 阻塞 C，不代表 A 自动阻塞 C）

---

## 负责人

设计上采用**单一负责人模型**。

- 每个 issue 同时最多只有一个负责人
- 这是刻意为之：清晰的所有权可防止责任扩散
- 对于涉及多人的协作工作，请使用分配给不同负责人的**子 issue**

在我们的场景中，agent 就是负责人。issue 上的 `assigneeId` 外键指向 `agents` 表。

---

## 子 Issue（父子关系）

Issue 支持父子嵌套。

- 在 issue 上设置 `parentId` 即可将其设为子 issue
- 子 issue 本身也可以有子 issue（支持多层嵌套）
- 子 issue 在创建时从父 issue 继承 **project**（非追溯性），但不继承团队、标签或负责人

### 自动关闭

- **子 issue 自动关闭**：当父 issue 完成时，剩余的子 issue 自动完成

### 转换

- 现有 issue 可以重新设置父级（添加或移除 `parentId`）
- 拥有大量子 issue 的父 issue 可以"晋升"为 project

---

## 估算

基于点数的估算，按团队配置。

### 可用量表

| 量表     | 取值                     |
| -------- | ------------------------ |
| Exponential | 1, 2, 4, 8, 16 (+32, 64) |

未估算的 issue 在进度/速度计算时默认为 1 点。

---

## 评论

| 字段         | 类型           | 说明                       |
| ------------ | -------------- | -------------------------- |
| `id`         | uuid           |                            |
| `body`       | text/markdown  |                            |
| `issueId`    | uuid FK        |                            |
| `authorId`   | uuid FK        | 可以是用户或 agent         |
| `parentId`   | uuid FK (self) | 用于线程式回复             |
| `resolvedAt` | timestamp      | 若线程已解决则设置此时间   |
| `createdAt`  | timestamp      |                            |
| `updatedAt`  | timestamp      |                            |

---

## Initiatives

最高层级的规划结构。将多个 project 归组到一个战略目标中。Initiative 有战略负责人，通常以结果/OKR 衡量，而非”完成/未完成”。

| 字段          | 类型    | 说明                             |
| ------------- | ------- | -------------------------------- |
| `id`          | uuid    |                                  |
| `name`        | string  |                                  |
| `description` | text    |                                  |
| `ownerId`     | uuid FK | 单一负责人                       |
| `status`      | enum    | `planned`, `active`, `completed` |
| `targetDate`  | date    |                                  |

Initiative 包含多个 project（多对多），并提供所有关联 project 进度的汇总视图。

---

## 标识符

Issue 使用人类可读的标识符：`{TEAM_KEY}-{NUMBER}`

- 团队前缀：每个团队设定的简短大写字符串（例如 "ENG"、"DES"）
- 编号：每个团队内自增的整数
- 示例：`ENG-123`、`DES-45`、`OPS-7`
- 若 issue 在团队间移动，将获得新标识符，旧标识符保留在 `previousIdentifiers` 中

这比 UUID 更适合人类交流。人们会说"去处理 ENG-42"，而不是"去处理 7f3a..."。

---

## 实体关系

```
Team (1) ----< (many) Issue
Team (1) ----< (many) WorkflowState
Team (1) ----< (many) Label (团队范围)

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

## 实现优先级

建议的构建顺序，价值最高者优先：

### 高价值

1. **Teams** -- `teams` 表 + issues 上的 `teamId` 外键。是人类可读标识符（`ENG-123`）和按团队配置工作流状态的基础。大多数其他功能依赖团队范围，因此应首先构建。
2. **Workflow states** -- `workflow_states` 表 + issues 上的 `stateId` 外键。基于类别的状态流转，支持每团队自定义工作流。
3. **Labels** -- `labels` + `issue_labels` 表。提供分类能力（bug/feature/chore、领域标签等），而不污染状态字段。
4. **Issue Relations** -- `issue_relations` 表。阻塞/被阻塞关系对于 agent 协调至关重要（agent A 无法在 agent B 完成前开始）。
5. **Sub-issues** -- `issues` 上的 `parentId` 自引用外键。让 agent 能够分解大型任务。
6. **Comments** -- `comments` 表。Agent 需要就 issue 进行沟通，而不是覆盖描述内容。

### 中等价值

7. **Transition timestamps** -- issues 上的 `startedAt`、`completedAt`、`cancelledAt`，由工作流状态变更自动设置。支持速度跟踪和 SLA 测量。

### 较低优先级（留待后期）

8. **Milestones** -- 当 project 复杂到需要划分阶段时有用。
9. **Initiatives** -- 当有多个 project 服务于同一战略目标时有用。
10. **Estimates** -- 当需要衡量吞吐量并预测产能时有用。
