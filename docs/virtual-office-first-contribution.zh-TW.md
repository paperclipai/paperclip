# Virtual Office 第一次貢獻 SOP

這份 SOP 給第一次想幫 Virtual Office 修文件、UI 文字、檢查清單或開源導覽的人使用。目標是讓貢獻者可以安全做小範圍改善，並保留 Hermes、Run now、排程與正式資料停手線。

## 適合第一次做的修改

- 修文件錯字、壞連結或不清楚的句子。
- 補一個新手看不懂的例子。
- 修 Virtual Office 畫面上的按鈕、說明文字或提示語。
- 把已分流回報轉成文件、UI、驗收清單或進度紀錄。
- 更新 `docs/virtual-office-acceptance-checklist.zh-TW.md` 與 UI 摘要，讓檢查清單同步。

## 第一次先不要做

- 不安裝 Hermes 或其它本地模型。
- 不填 API key、token、密碼或完整 `.env`。
- 不建立喚醒 issue、不按 Run now、不啟用 schedule trigger。
- 不修改正式資料或正式公司/客戶資料。
- 不把 UI skills 同步當成 runtime skill loading 已完成。
- 不把文件模板當成真人試讀已完成。

## 建議流程

1. 先看 `CONTRIBUTING.md` 與 `.github/PULL_REQUEST_TEMPLATE.md`。
2. 如果是讀者回報，先照 `docs/virtual-office-feedback-triage.zh-TW.md` 分流。
3. 再用 `docs/virtual-office-feedback-to-work-items.zh-TW.md` 把回報轉成一個小工作項目。
4. 只改和這個工作項目直接相關的文件或 UI。
5. 若改文件入口，更新開源導覽或文件地圖。
6. 若改驗收項，更新 UI 摘要與 `docs/virtual-office-acceptance-checklist.zh-TW.md`。
7. 收工前跑：

```powershell
pnpm run office:verify
```

## PR 內容應包含

- 這次解決的回報或問題。
- 改了哪些文件、UI 或檢查項。
- `pnpm run office:verify` 結果。
- 手動看過的頁面或文件。
- 是否更新驗收清單。
- 明確確認：沒有安裝 Hermes、沒有填憑證、沒有 Run now、沒有啟用排程、沒有喚醒模型、沒有放入密鑰或私密資料。

## 卡住時

如果你不確定這是不是安全的小改動，先把它當成需要維護者判斷：

```text
我想處理這個 Virtual Office 回報：
- 回報摘要：
- 我預計只改：
- 我不會碰：Hermes / Run now / schedule trigger / API key / .env / 正式資料
- 我需要確認：這是否適合第一次貢獻？
```

不要因為卡住就刪資料庫、刪 lock file、貼完整 log、填密鑰或喚醒本地模型。
