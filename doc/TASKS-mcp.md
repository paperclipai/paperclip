# 任务管理 MCP 接口

Paperclip 任务管理系统的函数契约。定义了智能体（及外部工具）通过 MCP 可用的操作。底层数据模型请参阅
[TASKS.md](./TASKS.md)。

所有操作均返回 JSON。ID 为 UUID，时间戳为 ISO 8601 格式。
在任何需要 issue `id` 的地方，均可接受 issue 标识符（例如 `ENG-123`）。

---

## Issues（问题）

### `list_issues`

列出并筛选工作区中的 issue。

| Parameter         | Type     | Required | Notes                                                                                           |
| ----------------- | -------- | -------- | ----------------------------------------------------------------------------------------------- |
| `query`           | string   | no       | 对标题和描述进行全文搜索                                                                        |
| `teamId`          | string   | no       | 按团队筛选                                                                                      |
| `status`         | string   | no       | 按特定工作流状态筛选                                                                            |
| `stateType`       | string   | no       | 按状态类别筛选：`triage`、`backlog`、`unstarted`、`started`、`completed`、`cancelled`           |
| `assigneeId`      | string   | no       | 按负责人筛选（智能体 ID）                                                                       |
| `projectId`       | string   | no       | 按项目筛选                                                                                      |
| `parentId`        | string   | no       | 按父 issue 筛选（返回子 issue）                                                                 |
| `labelIds`        | string[] | no       | 筛选同时包含所有这些标签的 issue                                                                |
| `priority`        | number   | no       | 按优先级筛选（0-4）                                                                             |
| `includeArchived` | boolean  | no       | 是否包含已归档的 issue。默认：false                                                             |
| `orderBy`         | string   | no       | `created`、`updated`、`priority`、`due_date`。默认：`created`                                   |
| `limit`           | number   | no       | 最大结果数。默认：50                                                                            |
| `after`           | string   | no       | 向后翻页游标                                                                                    |
| `before`          | string   | no       | 向前翻页游标                                                                                    |

**Returns:** `{ issues: Issue[], pageInfo: { hasNextPage, endCursor, hasPreviousPage, startCursor } }`

---

### `get_issue`

通过 ID 或标识符检索单个 issue，并展开所有关联关系。

| Parameter | Type   | Required | Notes                                              |
| --------- | ------ | -------- | -------------------------------------------------- |
| `id`      | string | yes      | UUID 或人类可读标识符（例如 `ENG-123`）             |

**Returns:** 完整的 `Issue` 对象，包含：

- `state`（展开的 WorkflowState）
- `assignee`（展开的 Agent，若已设置）
- `labels`（展开的 Label[]）
- `relations`（IssueRelation[]，含展开的关联 issue）
- `children`（子 issue 摘要：id、identifier、title、state、assignee）
- `parent`（摘要，若本 issue 为子 issue）
- `comments`（Comment[]，最新优先）

---

### `create_issue`

创建一个新 issue。

| Parameter     | Type     | Required | Notes                                         |
| ------------- | -------- | -------- | --------------------------------------------- |
| `title`       | string   | yes      |                                               |
| `teamId`      | string   | yes      | issue 所属的团队                               |
| `description` | string   | no       | Markdown 格式                                  |
| `status`     | string   | no       | 工作流状态。默认：团队默认状态                 |
| `priority`    | number   | no       | 0-4。默认：0（无）                             |
| `estimate`    | number   | no       | 点数估算                                       |
| `dueDate`     | string   | no       | ISO 日期                                       |
| `assigneeId`  | string   | no       | 指派的智能体                                   |
| `projectId`   | string   | no       | 关联的项目                                     |
| `milestoneId` | string   | no       | 项目内的里程碑                                 |
| `parentId`    | string   | no       | 父 issue（使本 issue 成为子 issue）            |
| `goalId`      | string   | no       | 关联的目标/目的                                |
| `labelIds`    | string[] | no       | 要应用的标签                                   |
| `sortOrder`   | number   | no       | 视图内的排序顺序                               |

**Returns:** 创建的 `Issue` 对象，包含计算字段（`identifier`、`createdAt` 等）。

**副作用：**

- 若设置了 `parentId`，则从父 issue 继承 `projectId`（除非显式提供）
- `identifier` 由团队 key 加下一个序列号自动生成

---

### `update_issue`

更新已有 issue。

| Parameter     | Type     | Required | Notes                                        |
| ------------- | -------- | -------- | -------------------------------------------- |
| `id`          | string   | yes      | UUID 或标识符                                 |
| `title`       | string   | no       |                                              |
| `description` | string   | no       |                                              |
| `status`     | string   | no       | 切换到新的工作流状态                           |
| `priority`    | number   | no       | 0-4                                          |
| `estimate`    | number   | no       |                                              |
| `dueDate`     | string   | no       | ISO 日期，或 `null` 以清除                    |
| `assigneeId`  | string   | no       | 智能体 ID，或 `null` 以取消指派               |
| `projectId`   | string   | no       | 项目 ID，或 `null` 以从项目中移除             |
| `milestoneId` | string   | no       | 里程碑 ID，或 `null` 以清除                   |
| `parentId`    | string   | no       | 重新指定父级，或 `null` 以升为独立 issue      |
| `goalId`      | string   | no       | 目标 ID，或 `null` 以取消关联                 |
| `labelIds`    | string[] | no       | **替换**所有标签（非追加）                    |
| `teamId`      | string   | no       | 移动到其他团队                               |
| `sortOrder`   | number   | no       | 视图内的排序顺序                             |

**Returns:** 更新后的 `Issue` 对象。

**副作用：**

- 将 `status` 更改为类别为 `started` 的状态时，会设置 `startedAt`（若尚未设置）
- 将 `status` 更改为 `completed` 时，会设置 `completedAt`
- 将 `status` 更改为 `cancelled` 时，会设置 `cancelledAt`
- 在启用子 issue 自动关闭的情况下，移动到 `completed`/`cancelled` 会完成所有未关闭的子 issue
- 更改 `teamId` 会重新分配标识符（例如 `ENG-42` → `DES-18`）；旧标识符保留在 `previousIdentifiers` 中

---

### `archive_issue`

软归档一个 issue。设置 `archivedAt`，不执行删除。

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |

**Returns:** `{ success: true }`

---

### `list_my_issues`

列出分配给特定智能体的 issue。是预填 `assigneeId` 的 `list_issues` 便捷封装。

| Parameter   | Type   | Required | Notes                          |
| ----------- | ------ | -------- | ------------------------------ |
| `agentId`   | string | yes      | 要列出 issue 的智能体           |
| `stateType` | string | no       | 按状态类别筛选                  |
| `orderBy`   | string | no       | 默认：`priority`                |
| `limit`     | number | no       | 默认：50                        |

**Returns:** 与 `list_issues` 返回结构相同。

---

## Workflow States（工作流状态）

### `list_workflow_states`

列出团队的工作流状态，按类别分组。

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `teamId`  | string | yes      |

**Returns:** `{ states: WorkflowState[] }` -- 按类别排序（triage、backlog、unstarted、started、completed、cancelled），同类别内再按 `position` 排序。

---

### `get_workflow_state`

Look up a workflow state by name or ID.

| Parameter | Type   | Required | Notes              |
| --------- | ------ | -------- | ------------------ |
| `teamId`  | string | yes      |                    |
| `query`   | string | yes      | State name or UUID |

**Returns:** Single `WorkflowState` object.

---

## Teams

### `list_teams`

List all teams in the workspace.

| Parameter | Type   | Required |
| --------- | ------ | -------- | -------------- |
| `query`   | string | no       | Filter by name |

**Returns:** `{ teams: Team[] }`

---

### `get_team`

Get a team by name, key, or ID.

| Parameter | Type   | Required | Notes                   |
| --------- | ------ | -------- | ----------------------- |
| `query`   | string | yes      | Team name, key, or UUID |

**Returns:** Single `Team` object.

---

## Projects

### `list_projects`

List projects in the workspace.

| Parameter         | Type    | Required | Notes                                                                           |
| ----------------- | ------- | -------- | ------------------------------------------------------------------------------- |
| `teamId`          | string  | no       | Filter to projects containing issues from this team                             |
| `status`          | string  | no       | Filter by status: `backlog`, `planned`, `in_progress`, `completed`, `cancelled` |
| `includeArchived` | boolean | no       | Default: false                                                                  |
| `limit`           | number  | no       | Default: 50                                                                     |
| `after`           | string  | no       | Cursor                                                                          |

**Returns:** `{ projects: Project[], pageInfo }`

---

### `get_project`

Get a project by name or ID.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `query`   | string | yes      |

**Returns:** Single `Project` object including `milestones[]` and issue count by state category.

---

### `create_project`

| Parameter     | Type   | Required |
| ------------- | ------ | -------- |
| `name`        | string | yes      |
| `description` | string | no       |
| `summary`     | string | no       |
| `leadId`      | string | no       |
| `startDate`   | string | no       |
| `targetDate`  | string | no       |

**Returns:** Created `Project` object. Status defaults to `backlog`.

---

### `update_project`

| Parameter     | Type   | Required |
| ------------- | ------ | -------- |
| `id`          | string | yes      |
| `name`        | string | no       |
| `description` | string | no       |
| `summary`     | string | no       |
| `status`      | string | no       |
| `leadId`      | string | no       |
| `startDate`   | string | no       |
| `targetDate`  | string | no       |

**Returns:** Updated `Project` object.

---

### `archive_project`

Soft-archive a project. Sets `archivedAt`. Does not delete.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |

**Returns:** `{ success: true }`

---

## Milestones

### `list_milestones`

| Parameter   | Type   | Required |
| ----------- | ------ | -------- |
| `projectId` | string | yes      |

**Returns:** `{ milestones: Milestone[] }` -- ordered by `sortOrder`.

---

### `get_milestone`

Get a milestone by ID.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |

**Returns:** Single `Milestone` object with issue count by state category.

---

### `create_milestone`

| Parameter     | Type   | Required |
| ------------- | ------ | -------- |
| `projectId`   | string | yes      |
| `name`        | string | yes      |
| `description` | string | no       |
| `targetDate`  | string | no       |
| `sortOrder`   | number | no       | Ordering within the project |

**Returns:** Created `Milestone` object.

---

### `update_milestone`

| Parameter     | Type   | Required |
| ------------- | ------ | -------- |
| `id`          | string | yes      |
| `name`        | string | no       |
| `description` | string | no       |
| `targetDate`  | string | no       |
| `sortOrder`   | number | no       | Ordering within the project |

**Returns:** Updated `Milestone` object.

---

## Labels

### `list_labels`

List labels available for a team (includes workspace-level labels).

| Parameter | Type   | Required | Notes                                     |
| --------- | ------ | -------- | ----------------------------------------- |
| `teamId`  | string | no       | If omitted, returns only workspace labels |

**Returns:** `{ labels: Label[] }` -- grouped by label group, ungrouped labels listed separately.

---

### `get_label`

Get a label by name or ID.

| Parameter | Type   | Required | Notes              |
| --------- | ------ | -------- | ------------------ |
| `query`   | string | yes      | Label name or UUID |

**Returns:** Single `Label` object.

---

### `create_label`

| Parameter     | Type   | Required | Notes                               |
| ------------- | ------ | -------- | ----------------------------------- |
| `name`        | string | yes      |                                     |
| `color`       | string | no       | Hex color. Auto-assigned if omitted |
| `description` | string | no       |                                     |
| `teamId`      | string | no       | Omit for workspace-level label      |
| `groupId`     | string | no       | Parent label group                  |

**Returns:** Created `Label` object.

---

### `update_label`

| Parameter     | Type   | Required |
| ------------- | ------ | -------- |
| `id`          | string | yes      |
| `name`        | string | no       |
| `color`       | string | no       |
| `description` | string | no       |

**Returns:** Updated `Label` object.

---

## Issue Relations

### `list_issue_relations`

List all relations for an issue.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `issueId` | string | yes      |

**Returns:** `{ relations: IssueRelation[] }` -- each with expanded `relatedIssue` summary (id, identifier, title, state).

---

### `create_issue_relation`

Create a relation between two issues.

| Parameter        | Type   | Required | Notes                                          |
| ---------------- | ------ | -------- | ---------------------------------------------- |
| `issueId`        | string | yes      | Source issue                                   |
| `relatedIssueId` | string | yes      | Target issue                                   |
| `type`           | string | yes      | `related`, `blocks`, `blocked_by`, `duplicate` |

**Returns:** Created `IssueRelation` object.

**Side effects:**

- `duplicate` auto-transitions the source issue to a cancelled state
- Creating `blocks` from A->B implicitly means B is `blocked_by` A (both
  directions visible when querying either issue)

---

### `delete_issue_relation`

Remove a relation between two issues.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |

**Returns:** `{ success: true }`

---

## Comments

### `list_comments`

List comments on an issue.

| Parameter | Type   | Required | Notes       |
| --------- | ------ | -------- | ----------- |
| `issueId` | string | yes      |             |
| `limit`   | number | no       | Default: 50 |

**Returns:** `{ comments: Comment[] }` -- threaded (top-level comments with nested `children`).

---

### `create_comment`

Add a comment to an issue.

| Parameter  | Type   | Required | Notes                                 |
| ---------- | ------ | -------- | ------------------------------------- |
| `issueId`  | string | yes      |                                       |
| `body`     | string | yes      | Markdown                              |
| `parentId` | string | no       | Reply to an existing comment (thread) |

**Returns:** Created `Comment` object.

---

### `update_comment`

Update a comment's body.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |
| `body`    | string | yes      |

**Returns:** Updated `Comment` object.

---

### `resolve_comment`

Mark a comment thread as resolved.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |

**Returns:** Updated `Comment` with `resolvedAt` set.

---

## Initiatives

### `list_initiatives`

| Parameter | Type   | Required | Notes                            |
| --------- | ------ | -------- | -------------------------------- |
| `status`  | string | no       | `planned`, `active`, `completed` |
| `limit`   | number | no       | Default: 50                      |

**Returns:** `{ initiatives: Initiative[] }`

---

### `get_initiative`

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `query`   | string | yes      |

**Returns:** Single `Initiative` object with expanded `projects[]` (summaries with status and issue count).

---

### `create_initiative`

| Parameter     | Type     | Required |
| ------------- | -------- | -------- |
| `name`        | string   | yes      |
| `description` | string   | no       |
| `ownerId`     | string   | no       |
| `targetDate`  | string   | no       |
| `projectIds`  | string[] | no       |

**Returns:** Created `Initiative` object. Status defaults to `planned`.

---

### `update_initiative`

| Parameter     | Type     | Required |
| ------------- | -------- | -------- |
| `id`          | string   | yes      |
| `name`        | string   | no       |
| `description` | string   | no       |
| `status`      | string   | no       |
| `ownerId`     | string   | no       |
| `targetDate`  | string   | no       |
| `projectIds`  | string[] | no       |

**Returns:** Updated `Initiative` object.

---

### `archive_initiative`

Soft-archive an initiative. Sets `archivedAt`. Does not delete.

| Parameter | Type   | Required |
| --------- | ------ | -------- |
| `id`      | string | yes      |

**Returns:** `{ success: true }`

---

## Summary

| Entity        | list | get | create | update | delete/archive |
| ------------- | ---- | --- | ------ | ------ | -------------- |
| Issue         | x    | x   | x      | x      | archive        |
| WorkflowState | x    | x   | --     | --     | --             |
| Team          | x    | x   | --     | --     | --             |
| Project       | x    | x   | x      | x      | archive        |
| Milestone     | x    | x   | x      | x      | --             |
| Label         | x    | x   | x      | x      | --             |
| IssueRelation | x    | --  | x      | --     | x              |
| Comment       | x    | --  | x      | x      | resolve        |
| Initiative    | x    | x   | x      | x      | archive        |

**Total: 35 operations**

Workflow states and teams are admin-configured, not created through the MCP.
The MCP is primarily for agents to manage their work: create issues, update
status, coordinate via relations and comments, and understand project context.
