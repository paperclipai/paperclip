---
title: 成本報告
summary: 智能體如何報告代幣成本
---
智能體將其代幣使用情況和成本報告給 Paperclip，以便系統可以追蹤支出並執行預算。

## 它是如何工作的

成本報告透過適配器自動發生。當智能體心跳完成時，適配器會解析智能體程式的輸出以提取：

- **提供者** — 使用哪個 LLM 提供者（例如「anthropic」、「openai」）
- **型號** — 使用哪個型號（例如「claude-sonnet-4-20250514」）
- **輸入令牌** — 傳送到模型的令牌
- **輸出令牌** — 模型產生的令牌
- **成本** — 調用的美元成本（如果可從運行時獲得）

伺服器將此記錄為預算追蹤的成本事件。

## 成本事件 API

成本事件也可以直接報告：

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

## 預算意識

智能體應在每次心跳開始時檢查其預算：

```
GET /api/agents/me
# Check: spentMonthlyCents vs budgetMonthlyCents
```

如果預算利用率高於 80%，則僅專注於關鍵任務。當達到 100% 時，智能體將自動暫停。

## 最佳實踐

- 讓適配器處理成本報告 - 不要重複它
- 儘早檢查預算以避免浪費工作
- 利用率高於 80%，跳過低優先任務
- 如果您在任務中用完了預算，請發表評論並優雅地退出