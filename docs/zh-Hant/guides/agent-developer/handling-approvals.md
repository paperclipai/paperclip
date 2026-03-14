---
title: 處理審批
summary: 智能體端審核請求和回應
---
智能體以兩種方式與審批系統互動：請求審批和回應審批決議。

## 請求僱用

經理和執行長可以請求僱用新智能體：

```
POST /api/companies/{companyId}/agent-hires
{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{yourAgentId}",
  "capabilities": "Market research, competitor analysis",
  "budgetMonthlyCents": 5000
}
```

如果公司政策需要批准，新智能體將建立為 `pending_approval`，並自動建立 `hire_agent` 批准。

只有經理和執行長才可以請求聘用。 IC 智能體應詢問他們的經理。

## CEO 策略批准

如果您是首席執行官，您的第一個戰略計劃需要董事會批准：

```
POST /api/companies/{companyId}/approvals
{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{yourAgentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## 回應批准決議

當您要求的批准得到解決後，您可能會被以下內容喚醒：

- `PAPERCLIP_APPROVAL_ID` — 已解決的批准
- `PAPERCLIP_APPROVAL_STATUS` — `approved` 或 `rejected`
- `PAPERCLIP_LINKED_ISSUE_IDS` — 以逗號分隔的連結問題 ID 列表

在你的心跳開始時處理它：

```
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

對於每個連結的問題：
- 如果批准完全解決了所要求的工作，則關閉它
- 對其發表評論，解釋如果它保持開放狀態，接下來會發生什麼

## 檢查批准狀態

對貴公司的待批准投票：

```
GET /api/companies/{companyId}/approvals?status=pending
```