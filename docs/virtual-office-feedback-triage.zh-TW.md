# Virtual Office 開源回報分流 SOP

這份 SOP 用在收到朋友、GitHub 讀者或開源試用者回報後。目標是先安全分流，再決定要改文件、UI、預覽流程、Hermes 前置說明，或轉到私下安全通報。

## 先做三件事

1. 確認回報沒有 API key、token、密碼、完整 `.env`、完整 log、私密路徑、正式客戶或公司資料。
2. 如果有敏感資訊，先請回報者刪除公開內容，改走 `SECURITY.md` 或 private security advisory。
3. 不要因為回報者提到 Hermes、Run now 或 schedule trigger，就把回報當成安裝、設定或喚醒授權。

## 分流類型

| 類型 | 看什麼 | 下一步 |
| --- | --- | --- |
| 預覽啟動卡住 | Backend / Frontend、`office:check`、狀態報告摘要 | 先照 startup SOP；不要刪資料庫或 lock file |
| 文件看不懂 | 卡住段落、原句、希望改法 | 用試讀證據紀錄與回填卡整理 |
| UI 文字或按鈕看不懂 | 頁面位置、按鈕名稱、預期與實際 | 建立 UI copy 或教學修正待辦 |
| skills / workflow 疑問 | Sandbox/Test 員工、desired skills、是否 runtime 證明 | 不把 UI 同步當成 runtime skill loading 完成 |
| Hermes / local model 前置 | bridge、provider/model 狀態、非敏感 Test environment 摘要 | 只做前置檢查；不填密鑰、不喚醒模型 |
| Routine / schedule 安全 | trigger、Run now、是否 Sandbox/Test | 先查 Routine safety notes，不碰正式資料 |
| 安全或敏感資訊 | 憑證、漏洞、私密資料、正式資料 | 停止公開討論，改走 private security path |

## 可用工具

- `複製 issue 回報`：整理 GitHub issue 欄位。
- `複製試用回報`：整理預覽試用狀態。
- `複製證據紀錄`：逐位保留讀者是否真的看懂。
- `複製回饋彙整`：把多份回報整理成必修、建議修、可延後與安全風險。
- `複製回填卡`：把回饋轉成文件、UI、安全提醒與驗收狀態更新。

## 分流後的判斷

- 可以立即修：文字錯誤、文件連結、UI 標籤、缺少範例。
- 需要更多證據：讀者說看不懂，但沒有指出原句或步驟。
- 必須暫停：涉及密鑰、資料庫刪除、Run now、schedule trigger、Hermes 喚醒或正式資料。
- 需要明確授權：任何安裝 Hermes、填憑證、建立喚醒 issue、Run now 或啟用排程。

## 最小回覆範本

```text
謝謝回報。我先把這份回報分到：
- 類型：
- 是否含敏感資訊：否 / 需要移除
- 下一步：文件修正 / UI 文字修正 / 預覽 SOP / Hermes 前置檢查 / 安全通報

我不會把這份回報視為 Hermes 安裝、Run now、排程或模型喚醒授權。
```
