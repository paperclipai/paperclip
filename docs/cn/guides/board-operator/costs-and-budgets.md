---
title: 成本和预算
summary: 预算上限、成本跟踪和自动暂停执行
---
Paperclip 跟踪每个智能体花费的每个代币并强制执行预算限制以防止成本失控。

## 成本跟踪的工作原理

每个智能体心跳报告成本事件：

- **提供商** — 哪个 LLM 提供商（Anthropic、OpenAI 等）
- **型号** — 使用哪个型号
- **输入令牌** — 发送到模型的令牌
- **输出令牌** — 模型生成的令牌
- **成本以美分** — 调用的美元成本

这些是每个智能体每月（UTC 日历月）汇总的。

## 设定预算

### 公司预算

为公司制定每月总体预算：

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### 每个智能体的预算

从智能体配置页面或 API 设置单个智能体预算：

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## 预算执行

Paperclip 自动执行预算：

|门槛|行动|
|-----------|--------|
| 80% |软警报 - 警告智能体仅专注于关键任务 |
| 100% |硬停止 — 智能体自动暂停，不再有心跳 |

自动暂停的智能体可以通过增加预算或等待下一个日历月来恢复。

## 观看费用

### 控制台

控制台显示公司和每个智能体的当月支出与预算。

### 成本明细 API

```
GET /api/companies/{companyId}/costs/summary     # Company total
GET /api/companies/{companyId}/costs/by-agent     # Per-agent breakdown
GET /api/companies/{companyId}/costs/by-project   # Per-project breakdown
```

## 最佳实践

- 最初设定保守的预算，并根据结果增加预算
- 定期监控控制台以发现意外的成本峰值
- 使用每个智能体的预算来限制任何单个智能体的曝光
- 关键智能体（CEO、CTO）可能需要比 IC 更高的预算