# Virtual Office 開源發布檢查表

這份檢查表用來確認 Virtual Office 能否放上 GitHub 讓其他新手試用。它不是 Hermes 安裝授權、不是 Run now 授權，也不是正式模型喚醒授權。

## 1. 基本驗證

發布前先執行：

```powershell
pnpm run office:verify
```

通過標準：

- UI typecheck 通過。
- Virtual Office 驗收清單同步通過。
- Virtual Office 文件連結檢查通過。
- Backend / Frontend 預覽健康檢查通過。
- render smoke 可載入 `http://localhost:5173/AI/office`。

如果 Backend 或 Frontend blocked，先照 `docs/virtual-office-startup-sop.zh-TW.md` 處理；不要刪資料庫、不要手動刪 `postmaster.pid`，也不要因為預覽 blocked 就喚醒 Hermes。

## 2. 公開入口

確認以下入口存在且互相連到：

- `README.md` 的 `Virtual Office` 區塊。
- `docs/virtual-office-getting-started.zh-TW.md`
- `docs/virtual-office-getting-started.en.md`
- `docs/virtual-office-quick-start.zh-TW.md`
- `docs/virtual-office-quick-start.en.md`
- `docs/virtual-office-open-source-readme.zh-TW.md`
- `docs/virtual-office-open-source-readme.en.md`
- `docs/virtual-office-public-status.zh-TW.md`
- `docs/virtual-office-public-commit-scope.zh-TW.md`
- `docs/virtual-office-public-commit-scope.en.md`
- `docs/virtual-office-pr-submission-plan.zh-TW.md`
- `docs/virtual-office-pr-submission-plan.en.md`
- `docs/virtual-office-pr-screenshot-evidence.zh-TW.md`
- `docs/virtual-office-pr-screenshot-evidence.en.md`
- `docs/virtual-office-pr-final-review.zh-TW.md`
- `docs/virtual-office-pr-final-review.en.md`
- `docs/virtual-office-acceptance-checklist.zh-TW.md`
- `docs/virtual-office-startup-sop.zh-TW.md`
- `docs/virtual-office-startup-sop.en.md`
- `docs/virtual-office-routine-safety.zh-TW.md`
- `docs/virtual-office-routine-safety.en.md`
- `docs/virtual-office-hermes-sop.zh-TW.md`
- `docs/virtual-office-release-decision.zh-TW.md`
- `docs/virtual-office-release-decision.en.md`
- `docs/virtual-office-release-notes-draft.zh-TW.md`
- `docs/virtual-office-release-notes-draft.en.md`
- `docs/virtual-office-feedback-triage.zh-TW.md`
- `docs/virtual-office-feedback-triage.en.md`
- `docs/virtual-office-maintainer-daily.zh-TW.md`
- `docs/virtual-office-maintainer-daily.en.md`
- `docs/virtual-office-feedback-to-work-items.zh-TW.md`
- `docs/virtual-office-feedback-to-work-items.en.md`
- `docs/virtual-office-first-contribution.zh-TW.md`
- `docs/virtual-office-first-contribution.en.md`
- `docs/virtual-office-pr-review.zh-TW.md`
- `docs/virtual-office-pr-review.en.md`

## 3. GitHub 回報與貢獻入口

確認以下檔案存在：

- `.github/ISSUE_TEMPLATE/virtual-office.yml`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `CONTRIBUTING.md`
- `SECURITY.md`

確認公開 issue template 有提醒：

- 不貼 API key、token、密碼或完整 `.env`。
- 不貼完整 log、私密路徑、私密 repo URL、內網 URL 或正式資料。
- issue 不是 Hermes 安裝、Run now、schedule trigger 或模型喚醒授權。

## 4. 不應提交的本機資料

確認下列檔案沒有被加入公開提交：

- `VIRTUAL_OFFICE_PROGRESS.md`
- `docs/virtual-office-current-handoff.zh-TW.md`
- `.paperclip-dev-config.json`
- `.paperclip-dev*.log`
- `paperclip-dev*.log`
- `.virtual-office-preview-status.json`
- `.virtual-office-stability-report.json`
- 任何 `.env`
- 任何含 API key、token、密碼、私密 URL、內網 URL、帳號路徑、正式客戶或公司資料的檔案

建議再跑一次：

```powershell
git status --ignored --short
```

## 5. Office 可複製的公開支援包

Office 的 `檢查清單` 區塊可複製：

- `複製開源安全包`
- `複製交付判斷`
- `複製試用回報`
- `複製 issue 回報`
- `複製 Gate 交接`
- `複製 Gate 決策`
- `複製閱讀準備`
- `複製新手自評`
- `複製真人試讀任務`
- `複製回饋彙整`
- `複製證據紀錄`
- `複製英文試讀包`

這些工具只是整理文字，不會建立 issue、不會 Run now、不會啟用 schedule trigger，也不會喚醒 Hermes 或其它本地模型。

## 6. 試讀證據

發布前可用 `複製證據紀錄` 整理試讀回饋。

逐位讀者紀錄至少包含：

- 讀者背景。
- 閱讀範圍。
- 是否知道第一步。
- 是否知道不要刪資料庫、不要貼密鑰、不要 Run now、不要喚醒 Hermes。
- 卡住原話或看不懂的句子。
- 是否需要改文件、UI 文字或安全提醒。

不要因為有文件或模板就不宣稱文件 gate 已完成。中文 UI 對照與安全提醒已由目前使用者確認清楚；英文文件仍建議等待英文讀者或英文母語使用者回饋後再優化。

## 7. Hermes / local model 停手線

目前可公開說明：

- `AI-98530` 已驗證 Hermes Sandbox/Test runtime capability-key proof。
- `AI-98533` 已驗證普通 Sandbox/Test 方案任務能由 Eve / Hermes local 產出可讀 comment，完成後回 paused/manual，active/live runs 為 0，使用者確認內容方向 OK。
- 60 分鐘穩定性測試與 3/3 重開機驗證已通過；後續發布前仍應再跑一次 `pnpm run office:verify` 作為當日證據。

仍需保留的邊界：

- Sandbox/Test 成功不等於正式專案授權。
- 下一次 Hermes / local model wake-up 仍需新的具體 issue、具體 agent 與新的逐字一次性授權。
- 若遇到 529、timeout、adapter failed、模型 API connection error 或其它 transient error，只記錄失敗並停下；不自動 retry、不建立 recovery issue、不開 continuation。
- GitHub issue、PR、文件檢查、試讀回報或一句「請繼續」都不是喚醒授權。

## 8. 發布判斷

發布前請看：

- `docs/virtual-office-release-decision.zh-TW.md`
- `docs/virtual-office-release-decision.en.md`
- `docs/virtual-office-release-notes-draft.zh-TW.md`
- `docs/virtual-office-release-notes-draft.en.md`

判斷只能是：

- `Go`：可公開試用，且安全邊界、文件入口、回報入口與驗收結果都清楚。
- `Pause`：有敏感資料、預覽不穩、文件入口缺漏、或安全邊界不清楚。
- `Internal Only`：功能可內測，但不適合對外公開。

## 9. 發布後維護

收到回報後，先看：

- `docs/virtual-office-feedback-triage.zh-TW.md`
- `docs/virtual-office-maintainer-daily.zh-TW.md`
- `docs/virtual-office-feedback-to-work-items.zh-TW.md`
- `docs/virtual-office-first-contribution.zh-TW.md`
- `docs/virtual-office-pr-review.zh-TW.md`

若回報像安全漏洞、密鑰外洩、正式資料外洩或可被利用的問題，請改走 `SECURITY.md`，不要在公開 issue 中追問敏感內容。
