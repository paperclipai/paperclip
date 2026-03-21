# 任务管理 MCP 接口

Paperclip 任务管理系统的函数合约。定义通过 MCP 提供给智能体（和外部工具）的操作。底层数据模型请参考 [TASKS.md](./TASKS.md)。

所有操作返回 JSON。ID 为 UUID。时间戳为 ISO 8601。
任务标识符（如 `ENG-123`）可以在任何接受任务 `id` 的地方使用。

---

## 任务

### `list_issues`

列出和筛选工作区中的任务。

| 参数 | 类型 | 必需 | 说明 |
| ----------------- | -------- | -------- | ----------------------------------------------------------------------------------------------- |
| `query` | string | 否 | 跨标题和描述的全文搜索 |
| `teamId` | string | 否 | 按团队筛选 |
| `status` | string | 否 | 按特定工作流状态筛选 |
| `stateType` | string | 否 | 按状态分类筛选：`triage`、`backlog`、`unstarted`、`started`、`completed`、`cancelled` |
| `assigneeId` | string | 否 | 按负责人（智能体 id）筛选 |
| `projectId` | string | 否 | 按项目筛选 |
| `parentId` | string | 否 | 按父任务筛选（返回子任务） |
| `labelIds` | string[] | 否 | 筛选具有所有这些标签的任务 |
| `priority` | number | 否 | 按优先级筛选（0-4） |
| `includeArchived` | boolean | 否 | 包含已归档的任务。默认：false |
| `orderBy` | string | 否 | `created`、`updated`、`priority`、`due_date`。默认：`created` |
| `limit` | number | 否 | 最大结果数。默认：50 |
| `after` | string | 否 | 前向分页游标 |
| `before` | string | 否 | 后向分页游标 |

**返回：** `{ issues: Issue[], pageInfo: { hasNextPage, endCursor, hasPreviousPage, startCursor } }`

---

### `get_issue`

按 ID 或标识符检索单个任务，展开所有关系。

| 参数 | 类型 | 必需 | 说明 |
| --------- | ------ | -------- | -------------------------------------------------- |
| `id` | string | 是 | UUID 或人类可读标识符（如 `ENG-123`） |

**返回：**完整 `Issue` 对象，包含：

- `state`（展开的 WorkflowState）
- `assignee`（展开的 Agent，如果设置）
- `labels`（展开的 Label[]）
- `relations`（IssueRelation[]，带展开的相关任务）
- `children`（子任务摘要：id、identifier、title、state、assignee）
- `parent`（摘要，如果这是子任务）
- `comments`（Comment[]，最新的在前）

---

### `create_issue`

创建新任务。

| 参数 | 类型 | 必需 | 说明 |
| ------------- | -------- | -------- | --------------------------------------------- |
| `title` | string | 是 | |
| `teamId` | string | 是 | 任务所属的团队 |
| `description` | string | 否 | Markdown |
| `status` | string | 否 | 工作流状态。默认：团队的默认状态 |
| `priority` | number | 否 | 0-4。默认：0（无） |
| `estimate` | number | 否 | 点数估算 |
| `dueDate` | string | 否 | ISO 日期 |
| `assigneeId` | string | 否 | 要分配的智能体 |
| `projectId` | string | 否 | 要关联的项目 |
| `milestoneId` | string | 否 | 项目内的里程碑 |
| `parentId` | string | 否 | 父任务（使其成为子任务） |
| `goalId` | string | 否 | 关联的目标 |
| `labelIds` | string[] | 否 | 要应用的标签 |
| `sortOrder` | number | 否 | 视图中的排序 |

**返回：**创建的 `Issue` 对象，包含计算字段（`identifier`、`createdAt` 等）

**副作用：**

- 如果设置了 `parentId`，从父任务继承 `projectId`（除非显式提供）
- `identifier` 从团队键 + 下一个序列号自动生成

---

### `update_issue`

更新现有任务。

| 参数 | 类型 | 必需 | 说明 |
| ------------- | -------- | -------- | -------------------------------------------- |
| `id` | string | 是 | UUID 或标识符 |
| `title` | string | 否 | |
| `description` | string | 否 | |
| `status` | string | 否 | 转换到新工作流状态 |
| `priority` | number | 否 | 0-4 |
| `estimate` | number | 否 | |
| `dueDate` | string | 否 | ISO 日期，或 `null` 以清除 |
| `assigneeId` | string | 否 | 智能体 id，或 `null` 以取消分配 |
| `projectId` | string | 否 | 项目 id，或 `null` 以从项目移除 |
| `milestoneId` | string | 否 | 里程碑 id，或 `null` 以清除 |
| `parentId` | string | 否 | 重新指定父任务，或 `null` 以提升为独立 |
| `goalId` | string | 否 | 目标 id，或 `null` 以取消关联 |
| `labelIds` | string[] | 否 | **替换**所有标签（非追加） |
| `teamId` | string | 否 | 移动到不同团队 |
| `sortOrder` | number | 否 | 视图中的排序 |

**返回：**更新的 `Issue` 对象。

**副作用：**

- 将 `status` 更改为分类为 `started` 的状态时设置 `startedAt`（如果尚未设置）
- 将 `status` 更改为 `completed` 时设置 `completedAt`
- 将 `status` 更改为 `cancelled` 时设置 `cancelledAt`
- 在启用子任务自动关闭的情况下移动到 `completed`/`cancelled` 会完成未关闭的子任务
- 更改 `teamId` 重新分配标识符（如 `ENG-42` -> `DES-18`）；旧标识符保留在 `previousIdentifiers` 中

---

### `archive_issue`

软归档任务。设置 `archivedAt`。不删除。

| 参数 | 类型 | 必需 |
| --------- | ------ | -------- |
| `id` | string | 是 |

**返回：** `{ success: true }`

---

### `list_my_issues`

列出分配给特定智能体的任务。`list_issues` 的便捷封装，预填 `assigneeId`。

| 参数 | 类型 | 必需 | 说明 |
| ----------- | ------ | -------- | ------------------------------ |
| `agentId` | string | 是 | 要列出其任务的智能体 |
| `stateType` | string | 否 | 按状态分类筛选 |
| `orderBy` | string | 否 | 默认：`priority` |
| `limit` | number | 否 | 默认：50 |

**返回：**与 `list_issues` 相同的形状。

---

## 工作流状态

### `list_workflow_states`

列出团队的工作流状态，按分类分组。

| 参数 | 类型 | 必需 |
| --------- | ------ | -------- |
| `teamId` | string | 是 |

**返回：** `{ states: WorkflowState[] }` —— 按分类排序（triage、backlog、unstarted、started、completed、cancelled），然后按每个分类内的 `position` 排序。

---

### `get_workflow_state`

按名称或 ID 查找工作流状态。

| 参数 | 类型 | 必需 | 说明 |
| --------- | ------ | -------- | ------------------ |
| `teamId` | string | 是 | |
| `query` | string | 是 | 状态名称或 UUID |

**返回：**单个 `WorkflowState` 对象。

---

## 团队

### `list_teams`

列出工作区中的所有团队。

| 参数 | 类型 | 必需 |
| --------- | ------ | -------- | -------------- |
| `query` | string | 否 | 按名称筛选 |

**返回：** `{ teams: Team[] }`

---

### `get_team`

按名称、键或 ID 获取团队。

| 参数 | 类型 | 必需 | 说明 |
| --------- | ------ | -------- | ----------------------- |
| `query` | string | 是 | 团队名称、键或 UUID |

**返回：**单个 `Team` 对象。

---

## 项目

### `list_projects`

列出工作区中的项目。

| 参数 | 类型 | 必需 | 说明 |
| ----------------- | ------- | -------- | ------------------------------------------------------------------------------- |
| `teamId` | string | 否 | 筛选包含此团队任务的项目 |
| `status` | string | 否 | 按状态筛选：`backlog`、`planned`、`in_progress`、`completed`、`cancelled` |
| `includeArchived` | boolean | 否 | 默认：false |
| `limit` | number | 否 | 默认：50 |
| `after` | string | 否 | 游标 |

**返回：** `{ projects: Project[], pageInfo }`

---

### `get_project`

按名称或 ID 获取项目。

| 参数 | 类型 | 必需 |
| --------- | ------ | -------- |
| `query` | string | 是 |

**返回：**单个 `Project` 对象，包含 `milestones[]` 和按状态分类的任务计数。

---

### `create_project`

| 参数 | 类型 | 必需 |
| ------------- | ------ | -------- |
| `name` | string | 是 |
| `description` | string | 否 |
| `summary` | string | 否 |
| `leadId` | string | 否 |
| `startDate` | string | 否 |
| `targetDate` | string | 否 |

**返回：**创建的 `Project` 对象。状态默认为 `backlog`。

---

### `update_project`

| 参数 | 类型 | 必需 |
| ------------- | ------ | -------- |
| `id` | string | 是 |
| `name` | string | 否 |
| `description` | string | 否 |
| `summary` | string | 否 |
| `status` | string | 否 |
| `leadId` | string | 否 |
| `startDate` | string | 否 |
| `targetDate` | string | 否 |

**返回：**更新的 `Project` 对象。

---

### `archive_project`

软归档项目。设置 `archivedAt`。不删除。

| 参数 | 类型 | 必需 |
| --------- | ------ | -------- |
| `id` | string | 是 |

**返回：** `{ success: true }`

---

## 里程碑

### `list_milestones`

| 参数 | 类型 | 必需 |
| ----------- | ------ | -------- |
| `projectId` | string | 是 |

**返回：** `{ milestones: Milestone[] }` —— 按 `sortOrder` 排序。

---

### `get_milestone`

按 ID 获取里程碑。

| 参数 | 类型 | 必需 |
| --------- | ------ | -------- |
| `id` | string | 是 |

**返回：**单个 `Milestone` 对象，包含按状态分类的任务计数。

---

### `create_milestone`

| 参数 | 类型 | 必需 |
| ------------- | ------ | -------- |
| `projectId` | string | 是 |
| `name` | string | 是 |
| `description` | string | 否 |
| `targetDate` | string | 否 |
| `sortOrder` | number | 否 | 项目内的排序 |

**返回：**创建的 `Milestone` 对象。

---

### `update_milestone`

| 参数 | 类型 | 必需 |
| ------------- | ------ | -------- |
| `id` | string | 是 |
| `name` | string | 否 |
| `description` | string | 否 |
| `targetDate` | string | 否 |
| `sortOrder` | number | 否 | 项目内的排序 |

**返回：**更新的 `Milestone` 对象。

---

## 标签

### `list_labels`

列出团队可用的标签（包含工作区级标签）。

| 参数 | 类型 | 必需 | 说明 |
| --------- | ------ | -------- | ----------------------------------------- |
| `teamId` | string | 否 | 如果省略，仅返回工作区标签 |

**返回：** `{ labels: Label[] }` —— 按标签组分组，未分组的标签单独列出。

---

### `get_label`

按名称或 ID 获取标签。

| 参数 | 类型 | 必需 | 说明 |
| --------- | ------ | -------- | ------------------ |
| `query` | string | 是 | 标签名称或 UUID |

**返回：**单个 `Label` 对象。

---

### `create_label`

| 参数 | 类型 | 必需 | 说明 |
| ------------- | ------ | -------- | ----------------------------------- |
| `name` | string | 是 | |
| `color` | string | 否 | 十六进制颜色。省略时自动分配 |
| `description` | string | 否 | |
| `teamId` | string | 否 | 省略表示工作区级标签 |
| `groupId` | string | 否 | 父标签组 |

**返回：**创建的 `Label` 对象。

---

### `update_label`

| 参数 | 类型 | 必需 |
| ------------- | ------ | -------- |
| `id` | string | 是 |
| `name` | string | 否 |
| `color` | string | 否 |
| `description` | string | 否 |

**返回：**更新的 `Label` 对象。

---

## 任务关系

### `list_issue_relations`

列出任务的所有关系。

| 参数 | 类型 | 必需 |
| --------- | ------ | -------- |
| `issueId` | string | 是 |

**返回：** `{ relations: IssueRelation[] }` —— 每个包含展开的 `relatedIssue` 摘要（id、identifier、title、state）。

---

### `create_issue_relation`

创建两个任务之间的关系。

| 参数 | 类型 | 必需 | 说明 |
| ---------------- | ------ | -------- | ---------------------------------------------- |
| `issueId` | string | 是 | 源任务 |
| `relatedIssueId` | string | 是 | 目标任务 |
| `type` | string | 是 | `related`、`blocks`、`blocked_by`、`duplicate` |

**返回：**创建的 `IssueRelation` 对象。

**副作用：**

- `duplicate` 自动将源任务转换为已取消状态
- 从 A->B 创建 `blocks` 隐含 B 被 A `blocked_by`（查询任一任务时两个方向都可见）

---

### `delete_issue_relation`

移除两个任务之间的关系。

| 参数 | 类型 | 必需 |
| --------- | ------ | -------- |
| `id` | string | 是 |

**返回：** `{ success: true }`

---

## 评论

### `list_comments`

列出任务上的评论。

| 参数 | 类型 | 必需 | 说明 |
| --------- | ------ | -------- | ----------- |
| `issueId` | string | 是 | |
| `limit` | number | 否 | 默认：50 |

**返回：** `{ comments: Comment[] }` —— 线程化（顶级评论包含嵌套的 `children`）。

---

### `create_comment`

向任务添加评论。

| 参数 | 类型 | 必需 | 说明 |
| ---------- | ------ | -------- | ------------------------------------- |
| `issueId` | string | 是 | |
| `body` | string | 是 | Markdown |
| `parentId` | string | 否 | 回复现有评论（线程） |

**返回：**创建的 `Comment` 对象。

---

### `update_comment`

更新评论正文。

| 参数 | 类型 | 必需 |
| --------- | ------ | -------- |
| `id` | string | 是 |
| `body` | string | 是 |

**返回：**更新的 `Comment` 对象。

---

### `resolve_comment`

将评论线程标记为已解决。

| 参数 | 类型 | 必需 |
| --------- | ------ | -------- |
| `id` | string | 是 |

**返回：**更新的 `Comment`，`resolvedAt` 已设置。

---

## 计划

### `list_initiatives`

| 参数 | 类型 | 必需 | 说明 |
| --------- | ------ | -------- | -------------------------------- |
| `status` | string | 否 | `planned`、`active`、`completed` |
| `limit` | number | 否 | 默认：50 |

**返回：** `{ initiatives: Initiative[] }`

---

### `get_initiative`

| 参数 | 类型 | 必需 |
| --------- | ------ | -------- |
| `query` | string | 是 |

**返回：**单个 `Initiative` 对象，包含展开的 `projects[]`（包含状态和任务计数的摘要）。

---

### `create_initiative`

| 参数 | 类型 | 必需 |
| ------------- | -------- | -------- |
| `name` | string | 是 |
| `description` | string | 否 |
| `ownerId` | string | 否 |
| `targetDate` | string | 否 |
| `projectIds` | string[] | 否 |

**返回：**创建的 `Initiative` 对象。状态默认为 `planned`。

---

### `update_initiative`

| 参数 | 类型 | 必需 |
| ------------- | -------- | -------- |
| `id` | string | 是 |
| `name` | string | 否 |
| `description` | string | 否 |
| `status` | string | 否 |
| `ownerId` | string | 否 |
| `targetDate` | string | 否 |
| `projectIds` | string[] | 否 |

**返回：**更新的 `Initiative` 对象。

---

### `archive_initiative`

软归档计划。设置 `archivedAt`。不删除。

| 参数 | 类型 | 必需 |
| --------- | ------ | -------- |
| `id` | string | 是 |

**返回：** `{ success: true }`

---

## 总结

| 实体 | list | get | create | update | delete/archive |
| ------------- | ---- | --- | ------ | ------ | -------------- |
| Issue | x | x | x | x | archive |
| WorkflowState | x | x | -- | -- | -- |
| Team | x | x | -- | -- | -- |
| Project | x | x | x | x | archive |
| Milestone | x | x | x | x | -- |
| Label | x | x | x | x | -- |
| IssueRelation | x | -- | x | -- | x |
| Comment | x | -- | x | x | resolve |
| Initiative | x | x | x | x | archive |

**总计：35 个操作**

工作流状态和团队由管理员配置，不通过 MCP 创建。MCP 主要供智能体管理其工作：创建任务、更新状态、通过关系和评论进行协调，以及理解项目上下文。
