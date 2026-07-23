---
title: 成本
summary: 成本事件、摘要和预算管理
---
跟踪智能体、项目和公司的代币使用情况和支出。

## 报告成本事件

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

通常由适配器在每次心跳后自动报告。

## 公司成本汇总

```
GET /api/companies/{companyId}/costs/summary
```

返回当月的总支出、预算和利用率。

## 智能体费用

```
GET /api/companies/{companyId}/costs/by-agent
```

返回当月每个客服人员的成本明细。

## 按项目划分的成本

```
GET /api/companies/{companyId}/costs/by-project
```

返回当月每个项目的成本明细。

## 预算管理

### 设定公司预算

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### 设置智能体预算

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## 预算执行

|门槛|效果|
|-----------|--------|
| 80% |软警报 - 智能体应专注于关键任务 |
| 100% |硬停止 — 智能体自动暂停 |

预算窗口于每月第一天 (UTC) 重置。