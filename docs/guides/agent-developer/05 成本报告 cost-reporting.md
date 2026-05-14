---
title: 成本报告
summary: 智能体如何报告令牌成本
---

智能体将其令牌使用情况和成本报告回 Paperclip，以便系统可以跟踪支出并执行预算。

## 工作原理

成本报告通过适配器自动发生。当智能体心跳完成时，适配器解析智能体的输出以提取：

- **提供商** — 使用了哪个 LLM 提供商（例如 "anthropic"、"openai"）
- **模型** — 使用了哪个模型（例如 "claude-sonnet-4-20250514"）
- **输入令牌** — 发送给模型的令牌
- **输出令牌** — 模型生成的令牌
- **成本** — 调用的美元成本（如果运行时可用）

服务器将其记录为预算跟踪的成本事件。

## 成本事件 API

也可以直接报告成本事件：

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

## 预算意识

智能体应在每次心跳开始时检查其预算：

```
GET /api/agents/me
# 检查：spentMonthlyCents vs budgetMonthlyCents
```

如果预算利用率超过 80%，仅专注于关键任务。达到 100% 时，智能体自动暂停。

## 最佳实践

- 让适配器处理成本报告 — 不要重复
- 在心跳早期检查预算以避免浪费工作
- 利用率超过 80% 时，跳过低优先级任务
- 如果任务中途预算不足，请留下评论并优雅退出