# Virtual Office 開源試用發布 Go / Pause SOP

這份 SOP 用在公開分享 Virtual Office 前做最後判斷。它不是理想版完成證明，也不是安裝 Hermes、按 Run now、啟用排程或喚醒模型的授權。

## Go：可以開放試用

所有條件都成立時，可以使用 `docs/virtual-office-release-notes-draft.zh-TW.md` 發布試用備註：

- `pnpm run office:verify` 通過。
- Backend OK、Frontend OK。
- README、入門文件、開源導覽、發布檢查表、issue form、PR template、CONTRIBUTING 與 SECURITY 入口都存在。
- `docs/virtual-office-release-checklist.zh-TW.md` 已檢查。
- `docs/virtual-office-pr-review.zh-TW.md` 與 `docs/virtual-office-first-contribution.zh-TW.md` 已連到貢獻流程。
- `AI-98530` 已提供 Hermes Sandbox/Test runtime capability-key proof。
- `AI-98533` 已提供普通 Sandbox/Test 方案任務證據，Eve / Hermes local 產出可讀 comment，完成後回 paused/manual，使用者確認內容方向 OK。
- 60 分鐘穩定性測試與 3/3 重開機驗證已通過，預覽復原流程可作為開源試用前的基本檢查。
- 中文 UI 對照與安全提醒已確認清楚；英文文件仍清楚標示需要英文讀者回饋。
- 沒有提交 `.env`、本機 preview status、log、密鑰、私密路徑或正式資料。

Go 只代表「可以試用並回報問題」，不代表理想版完成，也不代表正式 Hermes 任務可免授權。

## Pause：先不要對外分享

只要符合任一條件，就先暫停公開：

- Backend 或 Frontend blocked，且沒有安全復原紀錄。
- `pnpm run office:verify` 未通過。
- 文件連結缺漏、英文可讀性檢查失敗，或 README 入口不完整。
- issue form、PR template、CONTRIBUTING、SECURITY 或 release checklist 缺少安全停手線。
- `.env`、API key、token、密碼、完整 log、私密路徑、正式客戶資料或公司資料可能被提交。
- Hermes、Run now、schedule trigger 或模型喚醒被寫成一般試用步驟。
- 發布備註暗示正式 runtime skill 使用、正式 Hermes 喚醒或英文文件人工回饋已完成，但沒有證據。

## Internal Only：繼續內部整理

以下狀態可以內部工作，但不適合公開試用：

- 文件已草擬，但尚未跑 `pnpm run office:verify`。
- UI 或檢查清單有變更，但 Markdown ledger 尚未同步。
- 回饋太模糊，沒有指出卡住的句子或步驟。
- Hermes readiness 還在整理，沒有明確逐字一次性授權。
- 預覽能打開，但沒有近期 `office:verify`、render smoke、重開機或穩定性紀錄可佐證。

## 最後決策紀錄

```text
## Virtual Office 開源試用發布判斷

- 日期：
- 判斷：Go / Pause / Internal Only
- `pnpm run office:verify`：通過 / 未通過 / 未跑
- Backend / Frontend：OK / blocked
- 文件入口：完整 / 需補
- GitHub 回報與 PR 路徑：完整 / 需補
- 本機檔案與敏感資料：乾淨 / 需清理
- 已有證據：AI-98530 runtime proof / AI-98533 ordinary Sandbox plan / 中文安全提醒確認 / 60 分鐘穩定性 / 3/3 重開機
- 剩餘 gate：英文文件回饋 / 正式 Hermes-local model wake-up
- 停手線確認：不安裝 Hermes、不 Run now、不啟用排程、不喚醒模型
- 下一步：
```

## 發布後仍要持續說清楚

- Virtual Office 可以公開試用並收集回饋。
- `AI-98530` 是 Sandbox/Test runtime capability-key 證據。
- `AI-98533` 是普通 Sandbox/Test 任務證據。
- issue、PR、文件回饋與讀者回饋都不是 Hermes 安裝或喚醒授權。
- 第一次貢獻建議從文件、UI 文字、檢查清單或開源導覽的小修正開始。
