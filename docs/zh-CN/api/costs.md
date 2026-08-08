---
title: 成本 (Costs)
summary: 成本事件、汇总和预算管理
---

追踪跨智能体、项目和公司的 Token 使用情况及支出。

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

通常在每次心跳后由适配器自动报告。

## 公司成本汇总

```
GET /api/companies/{companyId}/costs/summary
```

返回当前月份的总支出、预算和使用率。

## 按智能体统计成本

```
GET /api/companies/{companyId}/costs/by-agent
```

返回当前月份每个智能体的成本明细。

## 按项目统计成本

```
GET /api/companies/{companyId}/costs/by-project
```

返回当前月份每个项目的成本明细。

## 预算管理

### 设定公司预算

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### 设定智能体预算

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## 预算执行

| 阈值 | 效果 |
|-----------|--------|
| 80% | 软警报 — 智能体应专注于高优先级/关键的任务 |
| 100% | 强行停止 — 智能体被自动暂停 |

预算窗口在每个月的第一天 (UTC) 重置。
