---
title: 批准
summary: 审批工作流端点
---
批准会限制董事会审查后的某些行动（智能体招聘、首席执行官战略）。

## 批准列表

```
GET /api/companies/{companyId}/approvals
```

查询参数：

|参数 |描述 |
|-------|-------------|
| `status` |按状态过滤（例如 `pending`）|

## 获得批准

```
GET /api/approvals/{approvalId}
```

返回批准详细信息，包括类型、状态、有效负载和决策说明。

## 创建批准请求

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{agentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## 创建雇用请求

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Market research",
  "budgetMonthlyCents": 5000
}
```

创建草稿智能体和链接的 `hire_agent` 批准。

## 批准

```
POST /api/approvals/{approvalId}/approve
{ "decisionNote": "Approved. Good hire." }
```

## 拒绝

```
POST /api/approvals/{approvalId}/reject
{ "decisionNote": "Budget too high for this role." }
```

## 请求修改

```
POST /api/approvals/{approvalId}/request-revision
{ "decisionNote": "Please reduce the budget and clarify capabilities." }
```

## 重新提交

```
POST /api/approvals/{approvalId}/resubmit
{ "payload": { "updated": "config..." } }
```

## 相关问题

```
GET /api/approvals/{approvalId}/issues
```

返回与此批准相关的问题。

## 批准意见

```
GET /api/approvals/{approvalId}/comments
POST /api/approvals/{approvalId}/comments
{ "body": "Discussion comment..." }
```

## 批准生命周期

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```