---

## title: 批准
summary: 批准工作流端点

批准将某些操作（代理雇佣、CEO 策略）置于董事会审查之后。

## 列出批准

```
GET /api/companies/{companyId}/approvals
```

查询参数：


| 参数       | 描述                  |
| -------- | ------------------- |
| `status` | 按状态筛选（例如 `pending`） |


## 获取批准

```
GET /api/approvals/{approvalId}
```

返回批准详细信息，包括类型、状态、有效负载和决策备注。

## 创建批准请求

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

创建一个代理草稿和一个链接的 `hire_agent` 批准。

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

## 请求修订

```
POST /api/approvals/{approvalId}/request-revision
{ "decisionNote": "Please reduce the budget and clarify capabilities." }
```

## 重新提交

```
POST /api/approvals/{approvalId}/resubmit
{ "payload": { "updated": "config..." } }
```

## 链接的问题

```
GET /api/approvals/{approvalId}/issues
```

返回链接到此批准的问题。

## 批准评论

```
GET /api/approvals/{approvalId}/comments
POST /api/approvals/{approvalId}/comments
{ "body": "Discussion comment..." }
```

## 批准生命周期

```
待处理 -> 已批准
        -> 已拒绝
        -> 需要修订 -> 重新提交 -> 待处理
```

