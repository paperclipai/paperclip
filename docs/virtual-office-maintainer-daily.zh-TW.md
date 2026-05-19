# Virtual Office 維護者日常檢查 SOP

這份 SOP 給維護者或協作者每天開工時使用。目標是先確認預覽健康、文件與回報狀態，再處理 issue 或文件修正；它不是 Hermes 安裝、Run now、排程或模型喚醒授權。

## 每日先跑

```powershell
pnpm run office:verify
```

通過後應確認：

- UI 型別檢查通過。
- 驗收清單同步檢查通過。
- 文件連結檢查通過。
- Backend OK。
- Frontend OK。

如果預覽 blocked，先照 `docs/virtual-office-startup-sop.zh-TW.md` 或英文版處理；不要刪資料庫、不要手動刪 lock file、不要喚醒 Hermes。

## 回報檢查順序

1. 查看是否有新的 Virtual Office issue 或試用回報。
2. 先確認是否含敏感資訊；若有，改走 `SECURITY.md` 或 private security advisory。
3. 用 `docs/virtual-office-feedback-triage.zh-TW.md` 分流：預覽、文件、UI、Hermes 前置、Routine 安全或安全通報。
4. 用 `docs/virtual-office-feedback-to-work-items.zh-TW.md` 把已分流回報轉成文件、UI、驗收清單、進度紀錄或安全處理工作項目。
5. 對文件回報，先用 `複製證據紀錄` 與 `複製回填卡` 留下依據。
6. 對 runtime skills 或 Hermes 回報，只做 Sandbox/Test 或只讀檢查，不把回報視為安裝或喚醒授權。

## 每日可做

- 修文件錯字、壞連結、UI 文字或缺少範例。
- 引導第一次貢獻者照 `docs/virtual-office-first-contribution.zh-TW.md` 只做小範圍修正。
- 審查 PR 前照 `docs/virtual-office-pr-review.zh-TW.md` 確認驗證、同步與停手線。
- 對外分享前照 `docs/virtual-office-release-decision.zh-TW.md` 做 Go / Pause / Internal Only 判斷。
- 補充 release notes draft、open-source guide 或 getting started。
- 整理試讀證據與回饋彙整。
- 更新驗收清單與進度紀錄。
- 若需要公開進度，只更新 `docs/virtual-office-public-status.zh-TW.md`；不要提交 `VIRTUAL_OFFICE_PROGRESS.md` 或臨時交接檔。
- 只讀檢查 preview status、issue 狀態與 Sandbox/Test 資料。

## 每日先不要做

- 不安裝 Hermes 或其它本地模型。
- 不填 API key、token、密碼或完整 `.env`。
- 不建立喚醒 issue、不 Run now、不啟用 schedule trigger。
- 不把 skills UI 同步視為 runtime skill loading 已完成。
- 不把文件模板視為真人試讀已完成。

## 收工前

- 再跑一次 `pnpm run office:verify`。
- 把今日新增的驗收項目、文件與剩餘 gate 記到 `VIRTUAL_OFFICE_PROGRESS.md`。
- 若需要對外同步狀態，只把去個資後的摘要寫到 `docs/virtual-office-public-status.zh-TW.md`。
- 若 Backend / Frontend blocked，記錄 `.virtual-office-preview-status.json` 摘要，不刪資料庫。
- 確認沒有提交 `.env`、本機 preview status、log、密鑰或私密路徑。
