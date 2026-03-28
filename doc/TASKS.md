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

## Issue Relations / Dependencies

Four relation types between issues:

| Type         | Meaning                          | Behavior                                      |
| ------------ | -------------------------------- | --------------------------------------------- |
| `related`    | General connection               | Informational link                            |
| `blocks`     | This issue blocks another        | Blocked issue shown with flag                 |
| `blocked_by` | This issue is blocked by another | Inverse of blocks                             |
| `duplicate`  | This issue duplicates another    | Auto-moves the duplicate to a Cancelled state |

### IssueRelation Fields

| Field            | Type    | Notes                                          |
| ---------------- | ------- | ---------------------------------------------- |
| `id`             | uuid    |                                                |
| `type`           | enum    | `related`, `blocks`, `blocked_by`, `duplicate` |
| `issueId`        | uuid FK | Source issue                                   |
| `relatedIssueId` | uuid FK | Target issue                                   |

### Rules

- When a blocking issue is resolved, the relation becomes informational (flag
  turns green)
- Duplicate is one-directional (you mark the duplicate, not the canonical)
- Blocking is **not transitive** at the system level (A blocks B, B blocks C
  does not auto-block A->C)

---

## Assignees

**Single-assignee model** by design.

- Each issue has at most one assignee at a time
- This is deliberate: clear ownership prevents diffusion of responsibility
- For collaborative work involving multiple people, use **sub-issues** with
  different assignees

In our context, agents are the assignees. The `assigneeId` FK on issues
points to the `agents` table.

---

## Sub-issues (Parent/Child)

Issues support parent/child nesting.

- Setting `parentId` on an issue makes it a sub-issue
- Sub-issues can themselves have sub-issues (multi-level nesting)
- Sub-issues inherit **project** from their parent at creation
  time (not retroactively), but NOT team, labels, or assignee

### Auto-close

- **Sub-issue auto-close**: when parent completes, remaining sub-issues
  auto-complete

### Conversions

- Existing issues can be reparented (add or remove `parentId`)
- A parent issue with many sub-issues can be "promoted" to a project

---

## Estimates

Point-based estimation, configured per-team.

### Available Scales

| Scale       | Values                   |
| ----------- | ------------------------ |
| Exponential | 1, 2, 4, 8, 16 (+32, 64) |

Unestimated issues default to 1 point for progress/velocity calculations.

---

## Comments

| Field        | Type           | Notes                      |
| ------------ | -------------- | -------------------------- |
| `id`         | uuid           |                            |
| `body`       | text/markdown  |                            |
| `issueId`    | uuid FK        |                            |
| `authorId`   | uuid FK        | Can be a user or agent     |
| `parentId`   | uuid FK (self) | For threaded replies       |
| `resolvedAt` | timestamp      | If the thread was resolved |
| `createdAt`  | timestamp      |                            |
| `updatedAt`  | timestamp      |                            |

---

## Initiatives

The highest-level planning construct. Groups projects toward a strategic
objective. Initiatives have strategic owners, and are typically measured by outcomes/OKRs, not “done/not done.”

| Field         | Type    | Notes                            |
| ------------- | ------- | -------------------------------- |
| `id`          | uuid    |                                  |
| `name`        | string  |                                  |
| `description` | text    |                                  |
| `ownerId`     | uuid FK | Single owner                     |
| `status`      | enum    | `planned`, `active`, `completed` |
| `targetDate`  | date    |                                  |

Initiatives contain projects (many-to-many) and provide a rollup view of
progress across all contained projects.

---

## Identifiers

Issues use human-readable identifiers: `{TEAM_KEY}-{NUMBER}`

- Team key: short uppercase string set per team (e.g. "ENG", "DES")
- Number: auto-incrementing integer per team
- Examples: `ENG-123`, `DES-45`, `OPS-7`
- If an issue moves between teams, it gets a new identifier and the old one is
  preserved in `previousIdentifiers`

This is far better for human communication than UUIDs. People say "grab ENG-42"
not "grab 7f3a...".

---

## Entity Relationships

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

## Implementation Priority

Recommended build order, highest value first:

### High Value

1. **Teams** -- `teams` table + `teamId` FK on issues. Foundation for
   human-readable identifiers (`ENG-123`) and per-team workflow states. Most
   other features depend on team scoping, so build this first.
2. **Workflow states** -- `workflow_states` table + `stateId` FK on issues.
   Per-team custom workflows with category-based state transitions.
3. **Labels** -- `labels` + `issue_labels` tables. Categorization
   (bug/feature/chore, area tags, etc.) without polluting the status field.
4. **Issue Relations** -- `issue_relations` table. Blocking/blocked-by is
   essential for agent coordination (agent A can't start until agent B finishes).
5. **Sub-issues** -- `parentId` self-FK on `issues`. Lets agents break down
   large tasks.
6. **Comments** -- `comments` table. Agents need to communicate about issues
   without overwriting the description.

### Medium Value

7. **Transition timestamps** -- `startedAt`, `completedAt`, `cancelledAt` on
   issues, auto-set by workflow state changes. Enables velocity tracking and SLA
   measurement.

### Lower Priority (For Later)

8. **Milestones** -- Useful once projects get complex enough to need stages.
9. **Initiatives** -- Useful once we have multiple projects that serve a common
   strategic goal.
10. **Estimates** -- Useful once we want to measure throughput and predict
    capacity.
