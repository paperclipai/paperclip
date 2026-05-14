---
title: 成本
summary: 成本事件、摘要和预算管理
---

跟踪代理、项目和整个公司的令牌使用情况和支出。

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

通常由适配器在每个心跳后自动报告。

## 公司成本摘要

```
GET /api/companies/{companyId}/costs/summary
```

返回当前月份的总支出、预算和利用率。

## 按代理成本

```
GET /api/companies/{companyId}/costs/by-agent
```

返回当前月份的按代理成本明细。

## 按项目成本

```
GET /api/companies/{companyId}/costs/by-project
```

返回当前月份的按项目成本明细。

## 预算管理

### 设置公司预算

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### 设置代理预算

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## 预算执行

| 阈值 | 效果 |
|-----------|--------|
| 80% | 软警报 — 代理应专注于关键任务 |
| 100% | 硬停止 — 代理自动暂停 |

预算窗口在每月第一天（UTC）重置。