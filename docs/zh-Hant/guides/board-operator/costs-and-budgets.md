---
title: 成本和預算
summary: 預算上限、成本追蹤和自動暫停執行
---
Paperclip 追蹤每個智能體花費的每個代幣並強制執行預算限制以防止成本失控。

## 成本追蹤的工作原理

每個智能體心跳報告成本事件：

- **提供者** — 哪個 LLM 提供者（Anthropic、OpenAI 等）
- **型號** — 使用哪個型號
- **輸入令牌** — 傳送到模型的令牌
- **輸出令牌** — 模型產生的令牌
- **成本以美分** — 調用的美元成本

這些是每個智能體每月（UTC 日曆月）匯總的。

## 設定預算

### 公司預算

為公司製定每月總體預算：

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### 每個智能體的預算

從智能體設定頁面或 API 設定單一智能體預算：

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## 預算執行

Paperclip 自動執行預算：

|門檻|行動|
|-----------|--------|
| 80% |軟警報 - 警告智能體僅專注於關鍵任務 |
| 100% |硬停止 — 智能體自動暫停，不再有心跳 |

自動暫停的智能體可以透過增加預算或等待下一個日曆月來恢復。

## 觀看費用

### 控制台

控制台顯示公司和每個智能體的當月支出與預算。

### 成本明細 API

```
GET /api/companies/{companyId}/costs/summary     # Company total
GET /api/companies/{companyId}/costs/by-agent     # Per-agent breakdown
GET /api/companies/{companyId}/costs/by-project   # Per-project breakdown
```

## 最佳實踐

- 最初設定保守的預算，並根據結果增加預算
- 定期監控控制台以發現意外的成本峰值
- 使用每個智能體的預算來限制任何單一智能體的曝光
- 關鍵智能體（CEO、CTO）可能需要比 IC 更高的預算