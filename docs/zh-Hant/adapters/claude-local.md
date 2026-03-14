---
title: Claude 本地
summary: Claude Code 本機適配器設定與配置
---
`claude_local` 轉接器在本地運行 Anthropic 的 Claude Code CLI。它支援會話持久化、技能注入和結構化輸出解析。

## 前置條件

- 安裝了Claude Code CLI（`claude`指令可用）
- `ANTHROPIC_API_KEY` 在環境或智能體程式設定中設置

## 設定字段

|領域 |類型 |必填 |說明 |
|-------|------|----------|-------------|
| `cwd` |字串|是的 |智能體程式的工作目錄（絕對路徑；如果權限允許，則如果缺少則自動建立）|
| `model` |字串|沒有 |要使用的 Claude 型號（例如 `claude-opus-4-6`）|
| `promptTemplate` |字串|沒有 |用於所有運行的提示 |
| `env` |物件|沒有 |環境變數（支援秘密引用）|
| `timeoutSec` |數量 |沒有 |進程逾時（0 = 無逾時）|
| `graceSec` |數量 |沒有 |強制殺人前的寬限期 |
| `maxTurnsPerRun` |數量 |沒有 |每次心跳最大智能體轉數|
| `dangerouslySkipPermissions` |布林 |沒有 |跳過權限提示（僅限開發）|

## 提示模板

模板支援`{{variable}}`替換：

|變數|價值|
|----------|-------|
| `{{agentId}}` |智能體 ID |
| `{{companyId}}` |公司ID |
| `{{runId}}` |目前運行 ID |
| `{{agent.name}}` |智能體姓名 |
| `{{company.name}}` |公司名稱 |

## 會話保持

適配器在心跳之間保留 Claude Code 會話 ID。下次喚醒時，它會恢復現有對話，以便智能體保留完整的上下文。

會話復原可識別 cwd：如果自上次執行以來智能體程式的工作目錄發生更改，則會啟動新的會話。

如果復原因未知會話錯誤而失敗，則適配器會自動使用新會話重試。

## 技能注入

適配器建立一個臨時目錄，其中包含指向 Paperclip 技能的符號鏈接，並透過 `--add-dir` 傳遞它。這使得技能可以被發現，而不會污染智能體的工作目錄。

對於心跳運行之外的手動本地 CLI 使用（例如直接作為 `claudecoder` 運行），請使用：

```sh
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

這會在 `~/.claude/skills` 中安裝 Paperclip 技能，建立智能體 API 金鑰，並列印 shell 匯出以作為該智能體執行。

## 環境測試

使用 UI 中的「測試環境」按鈕來驗證適配器配置。它檢查：

- Claude CLI 已安裝並可存取
- 工作目錄是絕對且可用的（如果缺少且允許則自動建立）
- API 金鑰/驗證模式提示（`ANTHROPIC_API_KEY` 與訂閱登入）
- 即時 hello 探針（帶有提示符 `Respond with hello.` 的 `claude --print - --output-format stream-json --verbose`），用於驗證 CLI 準備情況