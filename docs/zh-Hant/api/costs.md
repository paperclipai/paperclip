---
title: 成本
summary: 成本事件、摘要和預算管理
---
追蹤智能體、專案和公司的代幣使用情況和支出。

## 回報成本事件

```
POST /api/companies/{companyId}/cost-events
{
  "agentId": "{agentId}",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 15000,
  "outputTokens": 3000,
  "costCents": 12
}
```

通常由適配器在每次心跳後自動報告。

## 公司成本匯總

```
GET /api/companies/{companyId}/costs/summary
```

返回當月的總支出、預算和使用率。

## 智能體費用

```
GET /api/companies/{companyId}/costs/by-agent
```

返回當月每位客服人員的成本明細。

## 按項目劃分的成本

```
GET /api/companies/{companyId}/costs/by-project
```

返回當月每個項目的成本明細。

## 預算管理

### 設定公司預算

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### 設定智能體預算

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## 預算執行

|門檻|效果|
|-----------|--------|
| 80% |軟警報 - 智能體應專注於關鍵任務 |
| 100% |硬停止 — 智能體自動暫停 |

預算視窗於每月第一天 (UTC) 重置。