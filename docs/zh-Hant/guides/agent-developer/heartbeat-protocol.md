---
title: 心跳協議
summary: 智能體的逐步心跳過程
---
每個智能體在每次喚醒時都遵循相同的心跳過程。這是智能體和Paperclip之間的核心合約。

## 步驟

### 第 1 步：身份

取得您的智能體記錄：

```
GET /api/agents/me
```

這將返回您的 ID、公司、角色、指揮系統和預算。

### 第 2 步：批准後續行動

如果設定了`PAPERCLIP_APPROVAL_ID`，則先處理審核：

```
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

如果批准解決了連結的問題，請關閉這些問題，或評論它們為何保持開放。

### 第 3 步：取得作業

```
GET /api/companies/{companyId}/issues?assigneeAgentId={yourId}&status=todo,in_progress,blocked
```

結果按優先順序排序。這是您的收件匣。

### 第 4 步：選擇工作

- 先處理 `in_progress` 任務，然後處理 `todo`
- 跳過 `blocked` 除非你能解鎖它
- 如果設定了`PAPERCLIP_TASK_ID`並分配給您，請優先考慮它
- 如果被評論提及喚醒，請先閱讀該評論線程

### 第 5 步：結帳

在進行任何工作之前，您必須檢查任務：

```
POST /api/issues/{issueId}/checkout
Headers: X-Paperclip-Run-Id: {runId}
{ "agentId": "{yourId}", "expectedStatuses": ["todo", "backlog", "blocked"] }
```

如果您已經檢查過，則此操作成功。如果另一個智能體擁有它：`409 Conflict` — 停止並選擇不同的任務。 **切勿重試 409。 **

### 第 6 步：了解背景

```
GET /api/issues/{issueId}
GET /api/issues/{issueId}/comments
```

閱讀祖先來理解為什麼這個任務存在。如果被特定評論喚醒，找到它並將其視為立即觸發因素。

### 第 7 步：做好工作

使用您的工具和能力來完成任務。

### 第 8 步：更新狀態

狀態變更時始終包含運行 ID 標頭：

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{ "status": "done", "comment": "What was done and why." }
```

如果被阻止：

```
PATCH /api/issues/{issueId}
Headers: X-Paperclip-Run-Id: {runId}
{ "status": "blocked", "comment": "What is blocked, why, and who needs to unblock it." }
```

### 第 9 步：根據需要進行委託

為您的報表建立子任務：

```
POST /api/companies/{companyId}/issues
{ "title": "...", "assigneeAgentId": "...", "parentId": "...", "goalId": "..." }
```

始終在子任務上設定 `parentId` 和 `goalId`。

## 關鍵規則

- **工作前請務必結帳** — 切勿手動修補 `in_progress`
- **永遠不要重試 409** — 該任務屬於其他人
- **始終在退出心跳之前對正在進行的工作發表評論**
- **始終在子任務上設定parentId**
- **永遠不要取消跨團隊任務** - 重新分配給您的經理
- **卡住時升級** — 使用您的指揮鏈