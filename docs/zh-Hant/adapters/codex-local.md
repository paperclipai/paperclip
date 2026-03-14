---
title: Codex 本地
summary: OpenAI Codex 本機適配器設定與配置
---
`codex_local` 轉接器在本地運行 OpenAI 的 Codex CLI。它透過 `previous_response_id` 連結支援會話持久性，並透過全域 Codex 技能目錄支援技能注入。

## 前置條件

- Codex CLI 安裝（`codex` 指令可用）
- `OPENAI_API_KEY` 在環境或智能體程式設定中設置

## 設定字段

|領域 |類型 |必填 |說明 |
|-------|------|----------|-------------|
| `cwd` |字串|是的 |智能體程序的工作目錄（絕對路徑；如果權限允許，則如果缺少則自動建立）|
| `model` |字串|沒有 |使用型號|
| `promptTemplate` |字串|沒有 |用於所有運行的提示 |
| `env` |物件|沒有 |環境變數（支援秘密引用）|
| `timeoutSec` |數量 |沒有 |進程逾時（0 = 無逾時）|
| `graceSec` |數量 |沒有 |強制殺人前的寬限期 |
| `dangerouslyBypassApprovalsAndSandbox` |布林 |沒有 |跳過安全檢查（僅限開發）|

## 會話保持

Codex 使用 `previous_response_id` 來實現會話連續性。適配器透過心跳序列化並恢復此訊息，從而允許智能體維護對話上下文。

## 技能注入

適配器將 Paperclip 技能符號連結到全域 Codex 技能目錄 (`~/.codex/skills`) 中。現有的使用者技能不會被覆蓋。

對於心跳運行之外的手動本地 CLI 使用（例如直接作為 `codexcoder` 運行），請使用：

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
```

這將安裝所有缺少的技能，建立智能體 API 金鑰，並列印 shell 匯出以作為該智能體程式運行。

## 環境測試

環境測試檢查：

- Codex CLI 已安裝並可存取
- 工作目錄是絕對且可用的（如果缺少且允許則自動建立）
- 認證訊號（`OPENAI_API_KEY`存在）
- 即時 hello 探針（帶有提示符 `Respond with hello.` 的 `codex exec --json -`），用於驗證 CLI 是否可以實際運行