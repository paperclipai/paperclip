---
title: 適配器概述
summary: 什麼是適配器以及它們如何將智能體連接到 Paperclip
---
適配器是 Paperclip 的編排層和智能體程式運作時之間的橋樑。每個適配器都知道如何呼叫特定類型的 AI 智能體並捕獲其結果。

## 適配器如何運作

當心跳觸發時，Paperclip：

1. 查找智能體的`adapterType`和`adapterConfig`
2. 使用執行上下文呼叫適配器的`execute()`函數
3. 適配器產生或呼叫智能體運行時
4. 適配器捕獲標準輸出，解析使用/成本數據，並返回結構化結果

## 內建適配器

|適配器|鍵入鍵 |描述 |
|---------|----------|-------------|
| [Claude 本地](/zh-Hant/adapters/claude-local) | `claude_local` |本地運行 Claude Code CLI |
| [Codex 本地](/zh-Hant/adapters/codex-local) | `codex_local` |在本地運行 OpenAI Codex CLI |
| [Gemini 本地](/zh-Hant/adapters/gemini-local) | `gemini_local` |在本地運行 Gemini CLI |
| OpenCode 本機 | `opencode_local` |本機運行 OpenCode CLI（多供應商 `provider/model`） |
| OpenClaw | `openclaw` |將喚醒有效負載傳送至 OpenClaw Webhook |
| [流程](/zh-Hant/adapters/process) | `process` |執行任意 shell 指令 |
| [HTTP](/zh-Hant/adapters/http) | `http` |向外部智能體程式發送 webhooks |

## 適配器架構

每個適配器都是一個包含三個模組的套件：

```
packages/adapters/<name>/
  src/
    index.ts            # Shared metadata (type, label, models)
    server/
      execute.ts        # Core execution logic
      parse.ts          # Output parsing
      test.ts           # Environment diagnostics
    ui/
      parse-stdout.ts   # Stdout -> transcript entries for run viewer
      build-config.ts   # Form values -> adapterConfig JSON
    cli/
      format-event.ts   # Terminal output for `paperclipai run --watch`
```

三個註冊表使用這些模組：

|登記處 |它有什麼作用 |
|----------|-------------|
| **伺服器** |執行智能體，捕獲結果 |
| **使用者介面** |渲染運行記錄，提供設定表單 |
| **CLI** |格式化終端輸出以進行即時觀看 |

## 選擇適配器

- **需要編碼劑？ ** 使用 `claude_local`、`codex_local`、`gemini_local` 或 `opencode_local`
- **需要運行腳本或命令？ ** 使用 `process`
- **需要呼叫外部服務？ ** 使用`http`
- **需要客製化一些東西？ ** [建立您自己的適配器](/zh-Hant/adapters/creating-an-adapter)