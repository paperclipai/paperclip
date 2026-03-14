# 任务管理 MCP 界面

Paperclip任务管理系统的函数契约。定义
智能体（和外部工具）可通过 MCP 进行操作。参考
[TASKS.md](TASKS.md) 底层数据模型。

所有操作返回JSON。 ID 是 UUID。时间戳为 ISO 8601。
任何出现问题 `id` 的地方都接受问题标识符（例如 `ENG-123`）
预计。

---

## 问题

### `list_issues`

列出并过滤工作区中的问题。

|参数|类型 |必填 |笔记|
| ----------------- | -------- | -------- | ----------------------------------------------------------------------------------------------- |
| `query` |字符串|没有|跨标题和描述的自由文本搜索 |
| `teamId` |字符串|没有|按团队筛选 |
| `status` |字符串|没有|按特定工作流程状态过滤 |
| `stateType` |字符串|没有|按州类别过滤：`triage`、`backlog`、`unstarted`、`started`、`completed`、`cancelled` |
| `assigneeId` |字符串|没有|按受让人（智能体 ID）过滤 |
| `projectId` |字符串|没有|按项目筛选 |
| `parentId` |字符串|没有|按父问题过滤（返回子问题）|
| `labelIds` |字符串[] |没有|过滤所有这些标签的问题 |
| `priority` |数量 |没有|按优先级过滤 (0-4) |
| `includeArchived` |布尔 |没有|包括存档的问题。默认值： false |
| `orderBy` |字符串|没有| `created`、`updated`、`priority`、`due_date`。默认：`created` |
| `limit` |数量 |没有|最大结果。默认值：50 |
| `after` |字符串|没有| Cursor 正向分页 |
| `before` |字符串|没有| Cursor 向后分页 |

**返回：** `{ issues: Issue[], pageInfo: { hasNextPage, endCursor, hasPreviousPage, startCursor } }`

---### `get_issue`

通过 ID 或标识符检索单个问题，并扩展所有关系。

|参数|类型 |必填 |笔记|
| --------- | ------ | -------- | -------------------------------------------------- |
| `id` |字符串|是的 | UUID 或人类可读的标识符（例如 `ENG-123`）|

**返回：** 完整的 `Issue` 对象，包括：

- `state`（扩展的工作流程状态）
- `assignee`（扩展智能体，如果设置）
- `labels`（扩展标签[]）
- `relations`（IssueRelation[] 以及扩展的相关问题）
- `children`（子问题摘要：id、标识符、标题、状态、受让人）
- `parent`（摘要，如果这是一个子问题）
- `comments`（评论[]，最新的在前）

---

### `create_issue`

创建一个新问题。

|参数|类型 |必填 |笔记|
| ------------- | -------- | -------- | --------------------------------------------- |
| `title` |字符串|是的 |                                               |
| `teamId` |字符串|是的 |问题所属团队 |
| `description` |字符串|没有|降价|
| `status` |字符串|没有|工作流程状态。默认：团队的默认状态|
| `priority` |数量 |没有| 0-4。默认值：0（无）|
| `estimate` |数量 |没有|点估计|
| `dueDate` |字符串|没有| ISO 日期 |
| `assigneeId` |字符串|没有|智能体分配|
| `projectId` |字符串|没有|关联项目|
| `milestoneId` |字符串|没有|项目内的里程碑|
| `parentId` |字符串|没有|父问题（使其成为子问题）|
| `goalId` |字符串|没有|链接的目标/目的 |
| `labelIds` |字符串[] |没有|要应用的标签 |
| `sortOrder` |数量 |没有|在视图内订购|

**返回：** 使用计算字段创建 `Issue` 对象（`identifier`、`createdAt` 等）

**副作用：**

- 如果设置了 `parentId`，则从父级继承 `projectId`（除非明确提供）
- `identifier`是根据团队密钥+下一个序列号自动生成的

---

### `update_issue`

更新现有问题。|参数|类型 |必填 |笔记|
| ------------- | -------- | -------- | -------------------------------------------- |
| `id` |字符串|是的 | UUID 或标识符 |
| `title` |字符串|没有|                                              |
| `description` |字符串|没有|                                              |
| `status` |字符串|没有|过渡到新的工作流程状态 |
| `priority` |数量 |没有| 0-4 |
| `estimate` |数量 |没有|                                              |
| `dueDate` |字符串|没有| ISO 日期，或 `null` 来清除 |
| `assigneeId` |字符串|没有|智能体 ID，或 `null` 取消分配 |
| `projectId` |字符串|没有|要从项目中删除的项目 ID 或 `null` |
| `milestoneId` |字符串|没有|里程碑 id，或 `null` 清除 |
| `parentId` |字符串|没有| Reparent，或 `null` 升级为独立版 |
| `goalId` |字符串|没有|目标 ID，或 `null` 取消链接 |
| `labelIds` |字符串[] |没有| **替换**所有标签（非附加）|
| `teamId` |字符串|没有|转移到不同的团队|
| `sortOrder` |数量 |没有|在视图内订购 |

**返回：** 更新的 `Issue` 对象。

**副作用：**

- 将 `status` 更改为类别为 `started` 的状态会设置 `startedAt`（如果尚未设置）
- 将 `status` 更改为 `completed` 设置 `completedAt`
- 将 `status` 更改为 `cancelled` 设置 `cancelledAt`
- 移动到 `completed`/`cancelled` 并启用子问题自动关闭以完成打开的子问题
- 更改 `teamId` 会重新分配标识符（例如 `ENG-42` → `DES-18`）；旧标识符保留在 `previousIdentifiers` 中

---

### `archive_issue`

对问题进行软存档。设置 `archivedAt`。不删除。

|参数|类型 |必填 |
| --------- | ------ | -------- |
| `id` |字符串|是的 |

**返回：** `{ success: true }`

---

### `list_my_issues`

列出分配给特定智能体的问题。方便包装
`list_issues` 已预填充 `assigneeId`。

|参数|类型 |必填 |笔记|
| ----------- | ------ | -------- | ------------------------------ |
| `agentId` |字符串|是的 |要列出问题的智能体 |
| `stateType` |字符串|没有|按州类别过滤 |
| `orderBy` |字符串|没有|默认：`priority` |
| `limit` |数量 |没有|默认值：50 |

**返回：** 与 `list_issues` 形状相同。

---## 工作流程状态

### `list_workflow_states`

列出团队的工作流程状态，按类别分组。

|参数|类型 |必填 |
| --------- | ------ | -------- |
| `teamId` |字符串|是的 |

**返回：** `{ states: WorkflowState[] }` -- 按类别（分类、积压、未开始、开始、完成、取消）排序，然后按每个类别内的 `position` 排序。

---

### `get_workflow_state`

按名称或 ID 查找工作流状态。

|参数|类型 |必填 |笔记|
| --------- | ------ | -------- | ------------------ |
| `teamId` |字符串|是的 |                    |
| `query` |字符串|是的 |状态名称或 UUID |

**返回：** 单个 `WorkflowState` 对象。

---

## 团队

### `list_teams`

列出工作区中的所有团队。

|参数|类型 |必填 |
| --------- | ------ | -------- | -------------- |
| `query` |字符串|没有|按名称过滤 |

**返回：** `{ teams: Team[] }`

---

### `get_team`

按名称、密钥或 ID 获取团队。

|参数|类型 |必填 |笔记|
| --------- | ------ | -------- | ----------------------- |
| `query` |字符串|是的 |团队名称、密钥或 UUID |

**返回：** 单个 `Team` 对象。

---

## 项目

### `list_projects`

列出工作区中的项目。

|参数|类型 |必填 |笔记|
| ----------------- | ------- | -------- | ------------------------------------------------------------------------------- |
| `teamId` |字符串|没有|筛选包含该团队问题的项目 |
| `status` |字符串|没有|按状态筛选：`backlog`、`planned`、`in_progress`、`completed`、`cancelled` |
| `includeArchived` |布尔 |没有|默认值： false |
| `limit` |数量 |没有|默认值：50 |
| `after` |字符串|没有| Cursor |

**返回：** `{ projects: Project[], pageInfo }`

---

### `get_project`

通过名称或 ID 获取项目。

|参数|类型 |必填 |
| --------- | ------ | -------- |
| `query` |字符串|是的 |

**返回：** 单个 `Project` 对象，包括 `milestones[]` 和按状态类别划分的问题计数。

---

### `create_project`

|参数|类型 |必填 |
| ------------- | ------ | -------- |
| `name` |字符串|是的 |
| `description` |字符串|没有|
| `summary` |字符串|没有|
| `leadId` |字符串|没有|
| `startDate` |字符串|没有|
| `targetDate` |字符串|没有|

**返回：** 创建了 `Project` 对象。状态默认为 `backlog`。

---

### `update_project`|参数|类型 |必填 |
| ------------- | ------ | -------- |
| `id` |字符串|是的 |
| `name` |字符串|没有|
| `description` |字符串|没有|
| `summary` |字符串|没有|
| `status` |字符串|没有|
| `leadId` |字符串|没有|
| `startDate` |字符串|没有|
| `targetDate` |字符串|没有|

**返回：** 更新 `Project` 对象。

---

### `archive_project`

对项目进行软归档。设置 `archivedAt`。不删除。

|参数|类型 |必填 |
| --------- | ------ | -------- |
| `id` |字符串|是的 |

**返回：** `{ success: true }`

---

## 里程碑

### `list_milestones`

|参数|类型 |必填 |
| ----------- | ------ | -------- |
| `projectId` |字符串|是的 |

**退货：** `{ milestones: Milestone[] }` -- 由 `sortOrder` 订购。

---

### `get_milestone`

通过 ID 获取里程碑。

|参数|类型 |必填 |
| --------- | ------ | -------- |
| `id` |字符串|是的 |

**返回：** 单个 `Milestone` 对象，其问题计数按州类别划分。

---

### `create_milestone`

|参数|类型 |必填 |
| ------------- | ------ | -------- |
| `projectId` |字符串|是的 |
| `name` |字符串|是的 |
| `description` |字符串|没有|
| `targetDate` |字符串|没有|
| `sortOrder` |数量 |没有|项目内订购 |

**返回：** 创建了 `Milestone` 对象。

---

### `update_milestone`

|参数|类型 |必填 |
| ------------- | ------ | -------- |
| `id` |字符串|是的 |
| `name` |字符串|没有|
| `description` |字符串|没有|
| `targetDate` |字符串|没有|
| `sortOrder` |数量 |没有|项目内订购 |

**返回：** 更新 `Milestone` 对象。

---

## 标签

### `list_labels`

列出团队可用的标签（包括工作区级别标签）。

|参数|类型 |必填 |笔记|
| --------- | ------ | -------- | ----------------------------------------- |
| `teamId` |字符串|没有|如果省略，则仅返回工作区标签 |

**返回：** `{ labels: Label[] }` -- 按标签组分组，未分组的标签单独列出。

---

### `get_label`

按名称或 ID 获取标签。

|参数|类型 |必填 |笔记|
| --------- | ------ | -------- | ------------------ |
| `query` |字符串|是的 |标签名称或 UUID |

**返回：** 单个 `Label` 对象。

---

### `create_label`|参数|类型 |必填 |笔记|
| ------------- | ------ | -------- | ----------------------------------- |
| `name` |字符串|是的 |                                     |
| `color` |字符串|没有|十六进制颜色。如果省略则自动分配 |
| `description` |字符串|没有|                                     |
| `teamId` |字符串|没有|省略工作区级别标签 |
| `groupId` |字符串|没有|父标签组 |

**返回：** 创建了 `Label` 对象。

---

### `update_label`

|参数|类型 |必填 |
| ------------- | ------ | -------- |
| `id` |字符串|是的 |
| `name` |字符串|没有|
| `color` |字符串|没有|
| `description` |字符串|没有|

**返回：** 更新的 `Label` 对象。

---

## 问题关系

### `list_issue_relations`

列出问题的所有关系。

|参数|类型 |必填 |
| --------- | ------ | -------- |
| `issueId` |字符串|是的 |

**返回：** `{ relations: IssueRelation[] }` -- 每个都有扩展的 `relatedIssue` 摘要（id、标识符、标题、状态）。

---

### `create_issue_relation`

创建两个问题之间的关系。

|参数|类型 |必填 |笔记|
| ---------------- | ------ | -------- | ---------------------------------------------- |
| `issueId` |字符串|是的 |来源问题 |
| `relatedIssueId` |字符串|是的 |目标问题|
| `type` |字符串|是的 | `related`、`blocks`、`blocked_by`、`duplicate` |

**返回：** 创建了 `IssueRelation` 对象。

**副作用：**

- `duplicate` 自动将源问题转换为已取消状态
- 从 A->B 创建 `blocks` 隐式意味着 B 是 `blocked_by` A（两者
  查询任一问题时方向可见）

---

### `delete_issue_relation`

删除两个问题之间的关系。

|参数|类型 |必填 |
| --------- | ------ | -------- |
| `id` |字符串|是的 |

**返回：** `{ success: true }`

---

## 评论

### `list_comments`

列出对某个问题的评论。

|参数|类型 |必填 |笔记|
| --------- | ------ | -------- | ----------- |
| `issueId` |字符串|是的 |             |
| `limit` |数量 |没有|默认值：50 |

**返回：** `{ comments: Comment[] }` -- 线程化（带有嵌套 `children` 的顶级注释）。

---

### `create_comment`

添加对问题的评论。

|参数|类型 |必填 |笔记|
| ---------- | ------ | -------- | ------------------------------------- |
| `issueId` |字符串|是的 |                                       |
| `body` |字符串|是的 |降价|
| `parentId` |字符串|没有|回复现有评论（话题）|

**返回：** 创建了 `Comment` 对象。

---

### `update_comment`

更新评论正文。|参数|类型 |必填 |
| --------- | ------ | -------- |
| `id` |字符串| yes      |
| `body` |字符串|是的 |

**Returns:** Updated `Comment` object.

---

### `resolve_comment`

Mark a comment thread as resolved.

|参数| Type   |必填 |
| --------- | ------ | -------- |
| `id` |字符串|是的 |

**Returns:** Updated `Comment` with `resolvedAt` set.

---

## 倡议

### `list_initiatives`

|参数|类型 |必填 | Notes                            |
| --------- | ------ | -------- | -------------------------------- |
| `status` |字符串|没有| `planned`, `active`, `completed` |
| `limit` |数量 |没有| Default: 50                      |

**Returns:** `{ initiatives: Initiative[] }`

---

### `get_initiative`

|参数|类型 |必填 |
| --------- | ------ | -------- |
| `query` |字符串|是的 |

**Returns:** Single `Initiative` object with expanded `projects[]` (summaries with status and issue count).

---

### `create_initiative`

|参数|类型 |必填 |
| ------------- | -------- | -------- |
| `name`        | string   | yes      |
| `description` | string   | no       |
| `ownerId`     | string   |没有|
| `targetDate`  |字符串|没有|
| `projectIds`  |字符串[] |没有|

**Returns:** Created `Initiative` object. Status defaults to `planned`.

---

### `update_initiative`

| Parameter     | Type     |必填 |
| ------------- | -------- | -------- |
| `id`          | string   | yes      |
| `name`        |字符串| no       |
| `description` | string   | no       |
| `status`      | string   | no       |
| `ownerId`     | string   | no       |
| `targetDate` | string   | no       |
| `projectIds`  |字符串[] |没有|

**Returns:** Updated `Initiative` object.

---

### `archive_initiative`

Soft-archive an initiative. Sets `archivedAt`. Does not delete.

|参数| Type   |必填 |
| --------- | ------ | -------- |
| `id` |字符串|是的 |

**Returns:** `{ success: true }`

---

## 总结

|实体|列表 |得到 |创建|更新 |删除/存档|
| ------------- | ---- | --- | ------ | ------ | -------------- |
|问题 | x    | x| x| x|档案 |
|工作流程状态 | x| x| --| --| --|
|团队| x    | x| --| --     | --|
| Project       | x    | x   | x| x      | archive        |
|里程碑| x    | x| x      | x| --             |
| Label         | x| x   | x      | x      | --             |
| IssueRelation | x    | --  | x      | --| x              |
| Comment       | x    | --| x      | x      | resolve        |
| Initiative    | x    | x| x      | x| archive        |

**Total: 35 operations**工作流状态和团队由管理员配置，而不是通过 MCP 创建。
MCP 主要供智能体管理他们的工作：创建问题、更新
状态，通过关系和评论进行协调，并了解项目背景。