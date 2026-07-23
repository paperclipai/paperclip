---
title: 成本报告 (Cost Reporting)
summary: 智能体如何报告 Token 成本
---

智能体会将其消耗的 Token (代币) 使用情况和成本报告给 Paperclip，以便系统能够追踪支出并执行预算限制。

## 它是如何工作的

成本报告通过适配器 (adapters) 自动进行。当智能体的心跳执行完成时，适配器会解析智能体的输出以提取以下信息：

- **提供商 (provider)** — 使用了哪家大语言模型 (LLM) 提供商（例如 "anthropic"、"openai"）
- **模型 (model)** — 使用了哪个模型（例如 "claude-sonnet-4-20250514"）
- **输入 Token (inputTokens)** — 发送给模型的 Token 数量
- **输出 Token (outputTokens)** — 模型生成的 Token 数量
- **成本 (costCents)** — 该次调用的美元成本（如果能从运行时获取的话）

服务器会将此记录为成本事件 (cost event)，用于预算追踪。

## 成本事件 API (Cost Event API)

成本事件也可以直接进行报告：

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

## 预算感知 (Budget Awareness)

智能体应当在每次心跳的开始时检查其自身预算：

```
GET /api/agents/me
# 比对: spentMonthlyCents (月已花费) 与 budgetMonthlyCents (月度预算)
```

如果预算使用率高于 `80%`，智能体应当只专注于高优先级的关键任务。当预算使用率达到 `100%` 时，智能体将被自动暂停运行。

## 最佳实践

- 让适配器处理成本报告 — 智能体本身不要去重复报告
- 尽早检查预算情况，以避免做无用功
- 当预算利用率超过 `80%` 时，跳过低优先级的任务
- 如果您在执行任务中途耗尽了预算，请发表一条评论说明情况，然后优雅地退出