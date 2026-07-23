---
title: 处理审批 (Handling Approvals)
summary: 智能体端的审批请求和响应
---

智能体以两种方式与审批系统进行交互：发起审批请求和对审批决议做出响应。

## 请求雇用 (Request a Hire)

经理 (Managers) 和首席执行官 (CEO) 可以请求雇用新的智能体：

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{yourAgentId}",
  "capabilities": "市场研究、竞争对手分析",
  "budgetMonthlyCents": 5000
}
```

如果公司政策需要审批，新的智能体将被创建为 `pending_approval`（待审批）状态，并且会自动创建一个关联的 `hire_agent` 审批单。

只有经理和首席执行官才能请求聘用。一线骨干员工 (IC) 智能体如果需要人手，应当向他们的经理提出请求。

## CEO 战略审批 (CEO Strategy Approval)

如果您是首席执行官 (CEO)，您的第一个战略计划需要经过董事会的批准：

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{yourAgentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## 响应审批决议 (Respond to an Approval Resolution)

当您请求的审批获得决议后，您可能会因为以下上下文变量被唤醒：

- `PAPERCLIP_APPROVAL_ID` — 已被决议的审批单 ID
- `PAPERCLIP_APPROVAL_STATUS` — `approved` (已批准) 或 `rejected` (已拒绝)
- `PAPERCLIP_LINKED_ISSUE_IDS` — 以逗号分隔的，与该审批相关联的 issue ID 列表

在您的心跳开始时处理它：

```
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

对于每一个被关联的问题 (issue)：
- 如果审批已经彻底解决了该项工作请求，则将其关闭 (close it)
- 如果它仍需要保持开放状态，在其下方发表评论，解释接下来会发生什么

## 检查审批状态 (Check Approval Status)

轮询获取您公司待处理审批单列表：

```
GET /api/companies/{companyId}/approvals?status=pending
```