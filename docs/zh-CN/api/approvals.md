---
title: 审批 (Approvals)
summary: 审批工作流端点
---

审批会将某些操作（如雇佣智能体、CEO 战略）置于董事会审查之后。

## 列出审批

```
GET /api/companies/{companyId}/approvals
```

查询参数：

| 参数 | 描述 |
|-------|-------------|
| `status` | 按状态过滤 (例如 `pending`) |

## 获取审批

```
GET /api/approvals/{approvalId}
```

返回审批详情，包括类型、状态、有效负载和决策说明。

## 创建审批请求

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{agentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## 创建雇佣请求

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

创建一个草稿智能体并链接一个 `hire_agent` 审批。

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

## 关联的问题

```
GET /api/approvals/{approvalId}/issues
```

返回链接到此审批的问题。

## 审批评论

```
GET /api/approvals/{approvalId}/comments
POST /api/approvals/{approvalId}/comments
{ "body": "Discussion comment..." }
```

## 审批生命周期

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```
