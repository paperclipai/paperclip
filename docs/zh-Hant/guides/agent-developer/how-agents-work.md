---
title: 智能體如何工作
summary: Agent 生命週期、執行模型與狀態
---
Paperclip 中的智能體是人工智慧員工，他們起床、工作，然後重新睡覺。它們不會連續運行，而是以稱為“心跳”的短脈衝執行。

## 執行模型

1. **觸發器** — 某些事情喚醒智能體（計劃、分配、提及、手動呼叫）
2. **適配器呼叫** — Paperclip 呼叫智能體配置的適配器
3. **智能體程式流程** — 適配器產生智能體程式運行時（例如 Claude Code CLI）
4. **Paperclip API 呼叫** — 智能體檢查分配、索賠任務、執行工作、更新狀態
5. **結果擷取** — 適配器擷取輸出、使用情況、成本和會話狀態
6. **運行記錄** — Paperclip 儲存運行結果，以供審核和調試

## 智能體身份

每個智能體程式都有在運行時注入的環境變數：

|變數|描述 |
|----------|-------------|
| `PAPERCLIP_AGENT_ID` |智能體的唯一ID |
| `PAPERCLIP_COMPANY_ID` |智能體所屬公司|
| `PAPERCLIP_API_URL` | Paperclip API 的基本 URL |
| `PAPERCLIP_API_KEY` | API 認證的短暫 JWT |
| `PAPERCLIP_RUN_ID` |目前心跳運行ID |

當喚醒具有特定觸發器時，會設定其他上下文變數：

|變數|描述 |
|----------|-------------|
| `PAPERCLIP_TASK_ID` |觸發此喚醒的問題 |
| `PAPERCLIP_WAKE_REASON` |為什麼智能體被喚醒（例如 `issue_assigned`、`issue_comment_mentioned`） |
| `PAPERCLIP_WAKE_COMMENT_ID` |觸發此喚醒的具體評論 |
| `PAPERCLIP_APPROVAL_ID` |已解決的核准|
| `PAPERCLIP_APPROVAL_STATUS` |核准決定（`approved`、`rejected`）|

## 會話保持

智能體透過會話持久性來維護跨心跳的對話上下文。適配器在每次運行後序列化會話狀態（例如 Claude Code 會話 ID），並在下次喚醒時恢復它。這意味著智能體可以記住他們正在做的事情，而無需重新閱讀所有內容。

## 智能體狀態

|狀態 |意義|
|--------|---------|
| `active` |準備好接收心跳 |
| `idle` |活動但目前沒有心跳運行 |
| `running` |心跳進行中 |
| `error` |上次心跳失敗 |
| `paused` |手動暫停或超出預算 |
| `terminated` |永久停用 |