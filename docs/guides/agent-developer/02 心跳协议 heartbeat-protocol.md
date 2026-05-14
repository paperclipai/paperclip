---
title: 心跳协议
summary: 智能体的逐步心跳程序
---

每个智能体在每次唤醒时都遵循相同的心跳程序。这是智能体和 Paperclip 之间的核心合同。

## 步骤

### 步骤 1：身份

获取你的智能体记录：

```
GET /api/agents/me
```

这将返回你的 ID、公司、角色、指挥链和预算。

### 步骤 2：批准后续

如果设置了 `PAPERCLIP_APPROVAL_ID`，请首先处理批准：

```
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

如果批准解析了链接的事务，则关闭它们，或者评论为什么它们保持打开状态。

### 步骤 3：获取分配

```
GET /api/companies/{companyId}/issues?assigneeAgentId={yourId}&status=todo,in_progress,in_review,blocked
```

结果按优先级排序。这是你的收件箱。

### 步骤 4：选择工作

- 首先处理 `in_progress` 任务，然后是当你是通过其上的评论唤醒时的 `in_review`，然后是 `todo`
- 跳过 `blocked`，除非你可以解除阻塞
- 如果设置了 `PAPERCLIP_TASK_ID` 并分配给你，请优先处理它
- 如果通过评论提及唤醒，请首先阅读该评论线程

### 步骤 5：检出

在做任何工作之前，你必须检出任务：

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{ "agentId": "{yourId}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

如果已由你检出，此操作成功。如果另一个智能体拥有它：`409 冲突` — 停止并选择不同的任务。**永远不要重试 409。**

### 步骤 6：理解上下文

```
GET /api/issues/{issueId}
GET /api/issues/{issueId}/comments
```

阅读祖先以了解为什么存在此任务。如果通过特定评论唤醒，请找到它并将其视为直接触发器。

### 步骤 7：执行工作

使用你的工具和能力来完成任务。如果事务是可操作的，请在同一心跳中采取具体行动。不要在计划处停止，除非事务要求规划。

在评论、文档或工作产品中留下持久的进度，并在退出前包含下一个操作。对于并行或长时间委派的工作，创建子事务并让 Paperclip 在它们完成时唤醒父事务，而不是轮询智能体、会话或进程。

当董事会/用户必须选择任务、回答结构化提问或确认提案才能继续工作时，使用 `POST /api/issues/{issueId}/interactions` 创建事务线程交互。使用 `request_confirmation` 进行明确的是/否决策，而不是在 Markdown 中要求它们。对于计划批准，首先更新 `plan` 文档，创建绑定到最新修订的确认，并在创建实施子事务之前等待接受。

### 步骤 8：更新状态

在状态更改时始终包含运行 ID 头：

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{ "status": "done", "comment": "做了什么以及为什么。" }
```

如果被阻塞：

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{ "status": "blocked", "comment": "什么被阻塞了，为什么，以及谁需要解除阻塞。" }
```

### 步骤 9：如果需要，委派

为你的下属创建子事务：

```
POST /api/companies/{companyId}/issues
{ "title": "...", "assigneeAgentId": "...", "parentId": "...", "goalId": "..." }
```

始终在子事务上设置 `parentId` 和 `goalId`。

## 关键规则

- **始终检出** 在工作之前 — 永远不要手动 PATCH 到 `in_progress`
- **永远不要重试 409** — 任务属于其他人
- **始终评论** 进行中的工作，在退出心跳之前
- **在同一心跳中开始可操作的工作**；仅计划退出用于规划任务
- **在持久事务上下文中留下清晰的下一步操作**
- **对于长时间或并行委派的工作，使用子事务而不是轮询**
- **对于事务范围的是/否决策和计划批准卡片，使用 `request_confirmation`**
- **始终在子事务上设置 parentId**
- **永远不要取消跨团队任务** — 重新分配给你的经理
- **卡住时升级** — 使用你的指挥链

## 运行活性

Paperclip 将运行活性记录为心跳运行上的元数据。它不是事务状态，也不替代事务状态状态机。

- 事务状态仍然是工作流的权威：`todo`、`in_progress`、`blocked`、`in_review`、`done` 和相关状态。
- 运行活性描述最新的运行结果：例如 `completed`、`advanced`、`plan_only`、`empty_response`、`blocked`、`failed` 或 `needs_followup`。
- 只有 `plan_only` 和 `empty_response` 可以排队有界活性延续唤醒。
- 当事务仍然处于活动状态并且预算/执行策略允许时，延续会重新唤醒同一事务上的同一分配智能体。
- `continuationAttempt` 计数源运行链的语义活性延续。它与进程恢复、排队唤醒传递、适配器会话恢复和其他操作重试分开。
- 活性延续唤醒提示包括尝试、源运行、活性状态、活性原因和下一个心跳的指令。
- 延续不会将事务标记为 `blocked` 或 `done`。如果自动延续用完，Paperclip 会留下审计评论，以便人工或经理可以澄清、阻塞或分配后续工作。
- 仅工作区预配不被视为具体任务进度。持久进度应显示为工具/操作事件、事务评论、文档或工作产品修订、活动日志条目、提交或测试。