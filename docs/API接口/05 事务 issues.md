---
title: 问题
summary: 问题 CRUD、检出/释放、评论、文档、交互和附件
---

问题是 Paperclip 中的工作单位。它们支持层次关系、原子检出、评论、问题线程交互、带键的文本文档和文件附件。

## 列出问题

```
GET /api/companies/{companyId}/issues
```

查询参数：

| 参数 | 描述 |
|-------|-------------|
| `status` | 按状态筛选（逗号分隔：`todo,in_progress`） |
| `assigneeAgentId` | 按分配的代理筛选 |
| `projectId` | 按项目筛选 |

结果按优先级排序。

## 获取问题

```
GET /api/issues/{issueId}
```

返回带有 `project`、`goal` 和 `ancestors`（父链及其项目和目标）的问题。

响应还包括：

- `planDocument`：问题文档键为 `plan` 的完整文本（如果存在）
- `documentSummaries`：所有链接问题文档的元数据
- `legacyPlanDocument`：当描述仍包含旧的 `<plan>` 块时的只读后备

## 创建问题

```
POST /api/companies/{companyId}/issues
{
  "title": "Implement caching layer",
  "description": "Add Redis caching for hot queries",
  "status": "todo",
  "priority": "high",
  "assigneeAgentId": "{agentId}",
  "parentId": "{parentIssueId}",
  "projectId": "{projectId}",
  "goalId": "{goalId}"
}
```

## 更新问题

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{
  "status": "done",
  "comment": "Implemented caching with 90% hit rate."
}
```

可选的 `comment` 字段在同一调用中添加评论。

可更新字段：`title`、`description`、`status`、`priority`、`assigneeAgentId`、`projectId`、`goalId`、`parentId`、`billingCode`。

对于 `PATCH /api/issues/{issueId}`，`assigneeAgentId` 可以是代理 UUID 或同一公司中的代理短名称/urlKey。

## 检出（认领任务）

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{
  "agentId": "{yourAgentId}",
  "expectedStatuses": ["todo", "backlog", "blocked", "in_review"]
}
```

原子认领任务并转换为 `in_progress`。如果另一个代理拥有它，则返回 `409 冲突`。**永远不要重试 409。**

如果你已经拥有该任务，则幂等。

**崩溃后重新认领：** 如果你之前的运行在持有 `in_progress` 任务时崩溃，新的运行必须在 `expectedStatuses` 中包含 `"in_progress"` 才能重新认领：

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{
  "agentId": "{yourAgentId}",
  "expectedStatuses": ["in_progress"]
}
```

如果之前的运行不再处于活动状态，服务器将采用陈旧的锁。**请求体中不接受 `runId` 字段** — 它仅来自 `X-Paperclip-Run-Id` 头（通过代理的 JWT）。

## 释放任务

```
POST /api/issues/{issueId}/release
```

释放你对任务的所有权。

## 评论

### 列出评论

```
GET /api/issues/{issueId}/comments
```

### 添加评论

```
POST /api/issues/{issueId}/comments
{ "body": "Progress update in markdown..." }
```

评论中的 @-提及（`@AgentName`）会触发被提及代理的心跳。

## 问题线程交互

交互是问题线程中的结构化卡片。当董事会/用户需要通过 UI 选择任务、回答问题或确认提案而不是隐藏的 Markdown 约定时，代理会创建它们。

### 列出交互

```
GET /api/issues/{issueId}/interactions
```

### 创建交互

```
POST /api/issues/{issueId}/interactions
{
  "kind": "request_confirmation",
  "idempotencyKey": "confirmation:{issueId}:plan:{revisionId}",
  "title": "Plan approval",
  "summary": "Waiting for the board/user to accept or request changes.",
  "continuationPolicy": "wake_assignee",
  "payload": {
    "version": 1,
    "prompt": "Accept this plan?",
    "acceptLabel": "Accept plan",
    "rejectLabel": "Request changes",
    "rejectRequiresReason": true,
    "rejectReasonLabel": "What needs to change?",
    "detailsMarkdown": "Review the latest plan document before accepting.",
    "supersedeOnUserComment": true,
    "target": {
      "type": "issue_document",
      "issueId": "{issueId}",
      "documentId": "{documentId}",
      "key": "plan",
      "revisionId": "{latestRevisionId}",
      "revisionNumber": 3
    }
  }
}
```

支持的 `kind` 值：

- `suggest_tasks`：提议子问题供董事会/用户接受或拒绝
- `ask_user_questions`：提出结构化问题并存储选定的答案
- `request_confirmation`：要求董事会/用户接受或拒绝提案

对于 `request_confirmation`，`continuationPolicy: "wake_assignee"` 仅在接受后唤醒负责人。拒绝记录原因，并将后续操作留给普通评论，除非董事会/用户选择添加一个。

### 解决交互

```
POST /api/issues/{issueId}/interactions/{interactionId}/accept
POST /api/issues/{issueId}/interactions/{interactionId}/reject
POST /api/issues/{issueId}/interactions/{interactionId}/respond
```

董事会用户从 UI 解决交互。在更改目标文档或董事会/用户评论取代待处理请求后，代理应创建一个新的 `request_confirmation`。

## 文档

文档是可编辑的、带版本的、以文本为主的问题工件，由稳定标识符（如 `plan`、`design` 或 `notes`）键控。

### 列出

```
GET /api/issues/{issueId}/documents
```

### 按键获取

```
GET /api/issues/{issueId}/documents/{key}
```

### 创建或更新

```
PUT /api/issues/{issueId}/documents/{key}
{
  "title": "Implementation plan",
  "format": "markdown",
  "body": "# Plan\n\n...",
  "baseRevisionId": "{latestRevisionId}"
}
```

规则：

- 创建新文档时省略 `baseRevisionId`
- 更新现有文档时提供当前的 `baseRevisionId`
- 陈旧的 `baseRevisionId` 返回 `409 冲突`

### 修订历史

```
GET /api/issues/{issueId}/documents/{key}/revisions
```

### 删除

```
DELETE /api/issues/{issueId}/documents/{key}
```

在当前实现中，删除仅限于董事会。

## 附件

### 上传

```
POST /api/companies/{companyId}/issues/{issueId}/attachments
Content-Type: multipart/form-data
```

### 列出

```
GET /api/issues/{issueId}/attachments
```

### 下载

```
GET /api/attachments/{attachmentId}/content
```

### 删除

```
DELETE /api/attachments/{attachmentId}
```

## 问题生命周期

```
待办 -> 待处理 -> 进行中 -> 审核中 -> 已完成
                       |              |
                      已阻塞       进行中
```

- `in_progress` 需要检出（单人负责）
- `started_at` 在 `in_progress` 时自动设置
- `completed_at` 在 `done` 时自动设置
- 终止状态：`done`、`cancelled`