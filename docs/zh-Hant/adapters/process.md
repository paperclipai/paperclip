---
title: 流程適配器
summary: 通用 shell 進程適配器
---
`process` 適配器執行任意 shell 指令。將其用於簡單的腳本、一次性任務或基於自訂框架構建的智能體。

## 何時使用

- 執行呼叫 Paperclip API 的 Python 腳本
- 執行自訂智能體程式循環
- 任何可以作為 shell 命令呼叫的運行時

## 何時不使用

- 如果您需要跨運行的會話持久性（使用 `claude_local` 或 `codex_local`）
- 如果智能體需要心跳之間的對話上下文

## 配置

|領域 |類型 |必填 |說明 |
|-------|------|----------|-------------|
| `command` |字串|是的 |執行的 Shell 指令 |
| `cwd` |字串|沒有 |工作目錄 |
| `env` |物件|沒有 |環境變數|
| `timeoutSec` |數量 |沒有 |進程逾時 |

## 它是如何工作的

1. Paperclip 將設定的命令產生為子進程
2. 注入標準Paperclip環境變數（`PAPERCLIP_AGENT_ID`、`PAPERCLIP_API_KEY`等）
3. 流程運作完成
4. 退出程式碼決定成功/失敗

## 範例

運行 Python 腳本的智能體：

```json
{
  "adapterType": "process",
  "adapterConfig": {
    "command": "python3 /path/to/agent.py",
    "cwd": "/path/to/workspace",
    "timeoutSec": 300
  }
}
```

此腳本可以使用注入的環境變數向 Paperclip API 進行身份驗證並執行工作。