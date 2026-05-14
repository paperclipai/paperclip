# 任务管理 MCP 接口

Paperclip 任务管理系统的函数契约（Function Contract）。定义了代理（Agent）和外部工具通过 MCP 可用的操作。底层数据模型参见 [TASKS.md](./TASKS.md)。

所有操作返回 JSON。ID 为 UUID。时间戳为 ISO 8601 格式。问题标识符（如 `ENG-123`）在任何需要问题 `id` 的地方均可使用。

---

## 问题（Issues）

### `list_issues`

列出并筛选工作区中的问题。

| 参数              | 类型     | 必填 | 说明                                                                                           |
| ----------------- | -------- | ---- | ---------------------------------------------------------------------------------------------- |
| `query`           | string   | 否   | 在标题和描述中进行全文搜索                                                                     |
| `teamId`          | string   | 否   | 按团队筛选                                                                                     |
| `status`          | string   | 否   | 按特定工作流状态（Workflow State）筛选                                                         |
| `stateType`       | string   | 否   | 按状态类别筛选：`triage`、`backlog`、`unstarted`、`started`、`completed`、`cancelled`          |
| `assigneeId`      | string   | 否   | 按负责人（代理 ID）筛选                                                                        |
| `projectId`       | string   | 否   | 按项目筛选                                                                                     |
| `parentId`        | string   | 否   | 按父问题筛选（返回子问题）                                                                     |
| `labelIds`        | string[] | 否   | 筛选包含所有指定标签的问题                                                                     |
| `priority`        | number   | 否   | 按优先级筛选（0-4）                                                                            |
| `includeArchived` | boolean  | 否   | 是否包含已归档的问题。默认：false                                                              |
| `orderBy`         | string   | 否   | 排序字段：`created`、`updated`、`priority`、`due_date`。默认：`created`                       |
| `limit`           | number   | 否   | 最大返回数量。默认：50                                                                         |
| `after`           | string   | 否   | 向前分页的游标（Cursor）                                                                       |
| `before`          | string   | 否   | 向后分页的游标                                                                                 |

**返回值：** `{ issues: Issue[], pageInfo: { hasNextPage, endCursor, hasPreviousPage, startCursor } }`

---

### `get_issue`

根据 ID 或标识符获取单个问题，并展开所有关联数据。

| 参数 | 类型   | 必填 | 说明                                  |
| ---- | ------ | ---- | ------------------------------------- |
| `id` | string | 是   | UUID 或人类可读标识符（如 `ENG-123`） |

**返回值：** 完整的 `Issue` 对象，包含：

- `state`（展开的 WorkflowState）
- `assignee`（展开的 Agent，如已设置）
- `labels`（展开的 Label[]）
- `relations`（IssueRelation[]，包含展开的关联问题）
- `children`（子问题摘要：id、identifier、title、state、assignee）
- `parent`（摘要，如果是子问题）
- `comments`（Comment[]，按时间倒序）

---

### `create_issue`

创建新问题。

| 参数          | 类型     | 必填 | 说明                              |
| ------------- | -------- | ---- | --------------------------------- |
| `title`       | string   | 是   |                                   |
| `teamId`      | string   | 是   | 问题所属团队                      |
| `description` | string   | 否   | Markdown 格式                     |
| `status`      | string   | 否   | 工作流状态。默认：团队默认状态    |
| `priority`    | number   | 否   | 0-4。默认：0（无）                |
| `estimate`    | number   | 否   | 故事点估算                        |
| `dueDate`     | string   | 否   | ISO 日期                          |
| `assigneeId`  | string   | 否   | 指派的代理                        |
| `projectId`   | string   | 否   | 关联的项目                        |
| `milestoneId` | string   | 否   | 项目内的里程碑（Milestone）       |
| `parentId`    | string   | 否   | 父问题（使其成为子问题）          |
| `goalId`      | string   | 否   | 关联的目标                        |
| `labelIds`    | string[] | 否   | 要应用的标签                      |
| `sortOrder`   | number   | 否   | 视图内的排序顺序                  |

**返回值：** 创建的 `Issue` 对象，包含计算字段（`identifier`、`createdAt` 等）。

**副作用：**

- 如果设置了 `parentId`，则继承父问题的 `projectId`（除非显式提供）
- `identifier` 由团队键 + 下一个序列号自动生成

---

### `update_issue`

更新现有问题。

| 参数          | 类型     | 必填 | 说明                                    |
| ------------- | -------- | ---- | --------------------------------------- |
| `id`          | string   | 是   | UUID 或标识符                           |
| `title`       | string   | 否   |                                         |
| `description` | string   | 否   |                                         |
| `status`      | string   | 否   | 转换到新的工作流状态                    |
| `priority`    | number   | 否   | 0-4                                     |
| `estimate`    | number   | 否   |                                         |
| `dueDate`     | string   | 否   | ISO 日期，或 `null` 清除                |
| `assigneeId`  | string   | 否   | 代理 ID，或 `null` 取消指派             |
| `projectId`   | string   | 否   | 项目 ID，或 `null` 从项目中移除         |
| `milestoneId` | string   | 否   | 里程碑 ID，或 `null` 清除               |
| `parentId`    | string   | 否   | 重新设置父问题，或 `null` 提升为独立问题 |
| `goalId`      | string   | 否   | 目标 ID，或 `null` 取消关联             |
| `labelIds`    | string[] | 否   | **替换**所有标签（非追加）              |
| `teamId`      | string   | 否   | 移动到其他团队                          |
| `sortOrder`   | number   | 否   | 视图内的排序顺序                        |

**返回值：** 更新后的 `Issue` 对象。

**副作用：**

- 将 `status` 更改为类别为 `started` 的状态时，会设置 `startedAt`（如尚未设置）
- 将 `status` 更改为 `completed` 时，会设置 `completedAt`
- 将 `status` 更改为 `cancelled` 时，会设置 `cancelledAt`
- 在启用了子问题自动关闭的情况下移动到 `completed`/`cancelled`，会自动完成未关闭的子问题
- 更改 `teamId` 会重新分配标识符（如 `ENG-42` → `DES-18`）；旧标识符保存在 `previousIdentifiers` 中

---

### `archive_issue`

软归档（Soft Archive）问题。设置 `archivedAt`，不删除。

| 参数 | 类型   | 必填 |
| ---- | ------ | ---- |
| `id` | string | 是   |

**返回值：** `{ success: true }`

---

### `list_my_issues`

列出分配给特定代理的问题。是 `list_issues` 并预填 `assigneeId` 的便捷封装。

| 参数        | 类型   | 必填 | 说明                   |
| ----------- | ------ | ---- | ---------------------- |
| `agentId`   | string | 是   | 要列出问题的代理       |
| `stateType` | string | 否   | 按状态类别筛选         |
| `orderBy`   | string | 否   | 默认：`priority`       |
| `limit`     | number | 否   | 默认：50               |

**返回值：** 与 `list_issues` 相同的结构。

---

## 工作流状态（Workflow States）

### `list_workflow_states`

列出团队的工作流状态，按类别分组。

| 参数     | 类型   | 必填 |
| -------- | ------ | ---- |
| `teamId` | string | 是   |

**返回值：** `{ states: WorkflowState[] }` —— 按类别排序（triage、backlog、unstarted、started、completed、cancelled），每个类别内按 `position` 排序。

---

### `get_workflow_state`

根据名称或 ID 查找工作流状态。

| 参数     | 类型   | 必填 | 说明             |
| -------- | ------ | ---- | ---------------- |
| `teamId` | string | 是   |                  |
| `query`  | string | 是   | 状态名称或 UUID  |

**返回值：** 单个 `WorkflowState` 对象。

---

## 团队（Teams）

### `list_teams`

列出工作区中的所有团队。

| 参数   | 类型   | 必填 | 说明         |
| ------ | ------ | ---- | ------------ |
| `query` | string | 否   | 按名称筛选   |

**返回值：** `{ teams: Team[] }`

---

### `get_team`

根据名称、键或 ID 获取团队。

| 参数   | 类型   | 必填 | 说明                   |
| ------ | ------ | ---- | ---------------------- |
| `query` | string | 是   | 团队名称、键或 UUID    |

**返回值：** 单个 `Team` 对象。

---

## 项目（Projects）

### `list_projects`

列出工作区中的项目。

| 参数              | 类型    | 必填 | 说明                                                                           |
| ----------------- | ------- | ---- | ------------------------------------------------------------------------------ |
| `teamId`          | string  | 否   | 筛选包含该团队问题的项目                                                       |
| `status`          | string  | 否   | 按状态筛选：`backlog`、`planned`、`in_progress`、`completed`、`cancelled`     |
| `includeArchived` | boolean | 否   | 默认：false                                                                    |
| `limit`           | number  | 否   | 默认：50                                                                       |
| `after`           | string  | 否   | 分页游标                                                                       |

**返回值：** `{ projects: Project[], pageInfo }`

---

### `get_project`

根据名称或 ID 获取项目。

| 参数   | 类型   | 必填 |
| ------ | ------ | ---- |
| `query` | string | 是   |

**返回值：** 单个 `Project` 对象，包含 `milestones[]` 及按状态类别统计的问题数量。

---

### `create_project`

| 参数          | 类型   | 必填 |
| ------------- | ------ | ---- |
| `name`        | string | 是   |
| `description` | string | 否   |
| `summary`     | string | 否   |
| `leadId`      | string | 否   |
| `startDate`   | string | 否   |
| `targetDate`  | string | 否   |

**返回值：** 创建的 `Project` 对象。状态默认为 `backlog`。

---

### `update_project`

| 参数          | 类型   | 必填 |
| ------------- | ------ | ---- |
| `id`          | string | 是   |
| `name`        | string | 否   |
| `description` | string | 否   |
| `summary`     | string | 否   |
| `status`      | string | 否   |
| `leadId`      | string | 否   |
| `startDate`   | string | 否   |
| `targetDate`  | string | 否   |

**返回值：** 更新后的 `Project` 对象。

---

### `archive_project`

软归档项目。设置 `archivedAt`，不删除。

| 参数 | 类型   | 必填 |
| ---- | ------ | ---- |
| `id` | string | 是   |

**返回值：** `{ success: true }`

---

## 里程碑（Milestones）

### `list_milestones`

| 参数        | 类型   | 必填 |
| ----------- | ------ | ---- |
| `projectId` | string | 是   |

**返回值：** `{ milestones: Milestone[] }` —— 按 `sortOrder` 排序。

---

### `get_milestone`

根据 ID 获取里程碑。

| 参数 | 类型   | 必填 |
| ---- | ------ | ---- |
| `id` | string | 是   |

**返回值：** 单个 `Milestone` 对象，包含按状态类别统计的问题数量。

---

### `create_milestone`

| 参数          | 类型   | 必填 | 说明             |
| ------------- | ------ | ---- | ---------------- |
| `projectId`   | string | 是   |                  |
| `name`        | string | 是   |                  |
| `description` | string | 否   |                  |
| `targetDate`  | string | 否   |                  |
| `sortOrder`   | number | 否   | 项目内的排序顺序 |

**返回值：** 创建的 `Milestone` 对象。

---

### `update_milestone`

| 参数          | 类型   | 必填 | 说明             |
| ------------- | ------ | ---- | ---------------- |
| `id`          | string | 是   |                  |
| `name`        | string | 否   |                  |
| `description` | string | 否   |                  |
| `targetDate`  | string | 否   |                  |
| `sortOrder`   | number | 否   | 项目内的排序顺序 |

**返回值：** 更新后的 `Milestone` 对象。

---

## 标签（Labels）

### `list_labels`

列出团队可用的标签（包含工作区级别标签）。

| 参数     | 类型   | 必填 | 说明                        |
| -------- | ------ | ---- | --------------------------- |
| `teamId` | string | 否   | 如省略，仅返回工作区级标签  |

**返回值：** `{ labels: Label[] }` —— 按标签组分组，未分组的标签单独列出。

---

### `get_label`

根据名称或 ID 获取标签。

| 参数   | 类型   | 必填 | 说明           |
| ------ | ------ | ---- | -------------- |
| `query` | string | 是   | 标签名称或 UUID |

**返回值：** 单个 `Label` 对象。

---

### `create_label`

| 参数          | 类型   | 必填 | 说明                        |
| ------------- | ------ | ---- | --------------------------- |
| `name`        | string | 是   |                             |
| `color`       | string | 否   | 十六进制颜色。省略则自动分配 |
| `description` | string | 否   |                             |
| `teamId`      | string | 否   | 省略则为工作区级别标签      |
| `groupId`     | string | 否   | 所属标签组                  |

**返回值：** 创建的 `Label` 对象。

---

### `update_label`

| 参数          | 类型   | 必填 |
| ------------- | ------ | ---- |
| `id`          | string | 是   |
| `name`        | string | 否   |
| `color`       | string | 否   |
| `description` | string | 否   |

**返回值：** 更新后的 `Label` 对象。

---

## 问题关联（Issue Relations）

### `list_issue_relations`

列出问题的所有关联关系。

| 参数      | 类型   | 必填 |
| --------- | ------ | ---- |
| `issueId` | string | 是   |

**返回值：** `{ relations: IssueRelation[] }` —— 每个关联包含展开的 `relatedIssue` 摘要（id、identifier、title、state）。

---

### `create_issue_relation`

创建两个问题之间的关联关系。

| 参数           | 类型   | 必填 | 说明                                           |
| -------------- | ------ | ---- | ---------------------------------------------- |
| `issueId`      | string | 是   | 源问题                                         |
| `relatedIssueId` | string | 是   | 目标问题                                       |
| `type`         | string | 是   | `related`、`blocks`、`blocked_by`、`duplicate` |

**返回值：** 创建的 `IssueRelation` 对象。

**副作用：**

- `duplicate` 会自动将源问题转换为已取消状态
- 创建 A→B 的 `blocks` 关联隐含意味着 B 被 A `blocked_by`（查询任一问题时两个方向均可见）

---

### `delete_issue_relation`

删除两个问题之间的关联关系。

| 参数 | 类型   | 必填 |
| ---- | ------ | ---- |
| `id` | string | 是   |

**返回值：** `{ success: true }`

---

## 评论（Comments）

### `list_comments`

列出问题上的评论。

| 参数      | 类型   | 必填 | 说明       |
| --------- | ------ | ---- | ---------- |
| `issueId` | string | 是   |            |
| `limit`   | number | 否   | 默认：50   |

**返回值：** `{ comments: Comment[] }` —— 线程化结构（顶层评论包含嵌套的 `children`）。

---

### `create_comment`

向问题添加评论。

| 参数       | 类型   | 必填 | 说明                       |
| ---------- | ------ | ---- | -------------------------- |
| `issueId`  | string | 是   |                            |
| `body`     | string | 是   | Markdown 格式              |
| `parentId` | string | 否   | 回复现有评论（线程化）     |

**返回值：** 创建的 `Comment` 对象。

---

### `update_comment`

更新评论内容。

| 参数   | 类型   | 必填 |
| ------ | ------ | ---- |
| `id`   | string | 是   |
| `body` | string | 是   |

**返回值：** 更新后的 `Comment` 对象。

---

### `resolve_comment`

标记评论线程为已解决。

| 参数 | 类型   | 必填 |
| ---- | ------ | ---- |
| `id` | string | 是   |

**返回值：** 更新后的 `Comment`，`resolvedAt` 已设置。

---

## 计划（Initiatives）

### `list_initiatives`

| 参数     | 类型   | 必填 | 说明                                  |
| -------- | ------ | ---- | ------------------------------------- |
| `status` | string | 否   | `planned`、`active`、`completed`     |
| `limit`  | number | 否   | 默认：50                              |

**返回值：** `{ initiatives: Initiative[] }`

---

### `get_initiative`

| 参数   | 类型   | 必填 |
| ------ | ------ | ---- |
| `query` | string | 是   |

**返回值：** 单个 `Initiative` 对象，包含展开的 `projects[]`（带状态和问题数的摘要）。

---

### `create_initiative`

| 参数          | 类型     | 必填 |
| ------------- | -------- | ---- |
| `name`        | string   | 是   |
| `description` | string   | 否   |
| `ownerId`     | string   | 否   |
| `targetDate`  | string   | 否   |
| `projectIds`  | string[] | 否   |

**返回值：** 创建的 `Initiative` 对象。状态默认为 `planned`。

---

### `update_initiative`

| 参数          | 类型     | 必填 |
| ------------- | -------- | ---- |
| `id`          | string   | 是   |
| `name`        | string   | 否   |
| `description` | string   | 否   |
| `status`      | string   | 否   |
| `ownerId`     | string   | 否   |
| `targetDate`  | string   | 否   |
| `projectIds`  | string[] | 否   |

**返回值：** 更新后的 `Initiative` 对象。

---

### `archive_initiative`

软归档计划。设置 `archivedAt`，不删除。

| 参数 | 类型   | 必填 |
| ---- | ------ | ---- |
| `id` | string | 是   |

**返回值：** `{ success: true }`

---

## 总览

| 实体           | 列表 | 获取 | 创建 | 更新 | 删除/归档 |
| -------------- | ---- | ---- | ---- | ---- | --------- |
| Issue          | x    | x    | x    | x    | 归档      |
| WorkflowState  | x    | x    | --   | --   | --        |
| Team           | x    | x    | --   | --   | --        |
| Project        | x    | x    | x    | x    | 归档      |
| Milestone      | x    | x    | x    | x    | --        |
| Label          | x    | x    | x    | x    | --        |
| IssueRelation  | x    | --   | x    | --   | x         |
| Comment        | x    | --   | x    | x    | 解决      |
| Initiative     | x    | x    | x    | x    | 归档      |

**共计：35 个操作**

工作流状态和团队由管理员配置，不通过 MCP 创建。MCP 主要用于代理管理其工作：创建问题、更新状态、通过关联和评论进行协作，以及了解项目上下文。
