---
title: HTTP 轉接器
summary: HTTP Webhook 轉接器
---
`http` 適配器向外部智能體服務發送 Webhook 請求。該智能體在外部運行，Paperclip 只是觸發它。

## 何時使用

- 智能體程式以外部服務運作（雲端功能、專用伺服器）
- 即發即忘呼叫模型
- 與第三方智能體平台集成

## 何時不使用

- 如果智能體程式在同一台電腦上本地運行（使用 `process`、`claude_local` 或 `codex_local`）
- 如果您需要標準輸出捕獲和即時運行查看

## 配置

|領域 |類型 |必填 |說明 |
|-------|------|----------|-------------|
| `url` |字串|是的 |要 POST 到的 Webhook URL |
| `headers` |物件|沒有 |附加 HTTP 標頭 |
| `timeoutSec` |數量 |沒有 |請求逾時 |

## 它是如何工作的

1. Paperclip 向配置的URL發送POST請求
2. 請求體包含執行上下文（智能體ID、任務訊息、喚醒原因）
3. 外部智能體處理請求並回呼Paperclip API
4. 捕捉來自 webhook 的回應作為運行結果

## 請求正文

Webhook 接收 JSON 有效負載：

```json
{
  "runId": "...",
  "agentId": "...",
  "companyId": "...",
  "context": {
    "taskId": "...",
    "wakeReason": "...",
    "commentId": "..."
  }
}
```

外部智能體使用 `PAPERCLIP_API_URL` 和 API 鍵回撥 Paperclip。