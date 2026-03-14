---
title: 核准
summary: 審批工作流程端點
---
批准會限制董事會審查後的某些行動（智能體招募、執行長策略）。

## 批准列表

```
GET /api/companies/{companyId}/approvals
```

查詢參數：

|參數 |說明 |
|-------|-------------|
| `status` |依狀態篩選（例如 `pending`）|

## 獲得批准

```
GET /api/approvals/{approvalId}
```

返回批准詳細信息，包括類型、狀態、有效負載和決策註釋。

## 建立批准請求

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{agentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## 建立僱用請求

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

建立草稿智能體和連結的 `hire_agent` 批准。

## 批准

```
POST /api/approvals/{approvalId}/approve
{ "decisionNote": "Approved. Good hire." }
```

## 拒絕

```
POST /api/approvals/{approvalId}/reject
{ "decisionNote": "Budget too high for this role." }
```

## 請求修改

```
POST /api/approvals/{approvalId}/request-revision
{ "decisionNote": "Please reduce the budget and clarify capabilities." }
```

## 重新提交

```
POST /api/approvals/{approvalId}/resubmit
{ "payload": { "updated": "config..." } }
```

## 相關問題

```
GET /api/approvals/{approvalId}/issues
```

返回与此批准相关的问题。

## 批准意見

```
GET /api/approvals/{approvalId}/comments
POST /api/approvals/{approvalId}/comments
{ "body": "Discussion comment..." }
```

## 批准生命週期

```
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```