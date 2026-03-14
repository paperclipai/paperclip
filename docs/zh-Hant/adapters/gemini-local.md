---
title: Gemini 本地
summary: Gemini CLI 本機適配器設定與配置
---
`gemini_local` 轉接器在本地運行 Google 的 Gemini CLI。它支援 `--resume` 會話持久性、技能注入和結構化 `stream-json` 輸出解析。

## 前置條件

- Gemini CLI 已安裝（`gemini` 指令可用）
- `GEMINI_API_KEY` 或 `GOOGLE_API_KEY` 設定，或配置本地 Gemini CLI 驗證

## 設定字段

|領域 |類型 |必填 |說明 |
|-------|------|----------|-------------|
| `cwd` |字串|是的 |智能體程式的工作目錄（絕對路徑；如果權限允許，則如果缺少則自動建立）|
| `model` |字串|沒有 |使用Gemini型號。預設為 `auto`。 |
| `promptTemplate` |字串|沒有 |用於所有運行的提示 |
| `instructionsFilePath` |字串|沒有 |提示前新增 Markdown 說明檔 |
| `env` |物件|沒有 |環境變數（支援秘密引用）|
| `timeoutSec` |數量 |沒有 |進程逾時（0 = 無逾時）|
| `graceSec` |數量 |沒有 |強制殺人前的寬限期 |
| `yolo` |布林 |沒有 |透過`--approval-mode yolo`進行無人值守操作 |

## 會話保持

適配器在心跳之間保留 Gemini 會話 ID。下次喚醒時，它會恢復與 `--resume` 的現有對話，以便智能體保留上下文。

會話復原可識別 cwd：如果自上次執行以來工作目錄發生更改，則會啟動新的會話。

如果復原因未知會話錯誤而失敗，則適配器會自動使用新會話重試。

## 技能注入

適配器將 Paperclip 技能符號連結到 Gemini 全域技能目錄 (`~/.gemini/skills`) 中。現有的使用者技能不會被覆蓋。

## 環境測試

使用 UI 中的「測試環境」按鈕來驗證適配器配置。它檢查：

- Gemini CLI 已安裝並可存取
- 工作目錄是絕對且可用的（如果缺少且允許則自動建立）
- API 金鑰/驗證提示（`GEMINI_API_KEY` 或 `GOOGLE_API_KEY`）
- 即時 hello 探針 (`gemini --output-format json "Respond with hello."`)，用於驗證 CLI 準備情況