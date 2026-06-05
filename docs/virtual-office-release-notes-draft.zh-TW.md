# Virtual Office 開源發布備註草稿

這份草稿可用在第一次邀請朋友、GitHub 讀者或開源試用者體驗 Virtual Office。它只是試用公告，不是理想版完成宣告，也不是安裝 Hermes、按 Run now、啟用排程或喚醒本地模型的授權。

## 一句話

Virtual Office 是建立在 Paperclip 上的 2.5D 新手友善工作台，讓使用者用「AI 員工、skills、專案、工作流、會議紀錄與排程安全狀態」的方式理解和管理 agent。

## 目前可以試用

- 2.5D 辦公室總覽：員工、專案、工作流、會議與最近活動。
- 新手操作檯：建立員工、安裝 skills、建立工作流、開討論任務、查看檢查清單。
- 專案與工作流草稿：規劃階段、負責人、上下游順序或平行協作。
- 會議與覆盤紀錄：保留背景、決策、未解問題與下一步。
- Routine / schedule 安全提示：先從 Sandbox/Test 草稿開始，不自動 Run now。
- 開機與預覽復原 SOP：重開機後用固定流程檢查 Backend / Frontend。
- Hermes Sandbox/Test runtime capability-key proof：`AI-98530` 已證明模型可看見並回覆 7 個 exact Paperclip runtime capability keys。
- 普通 Sandbox/Test 方案任務：`AI-98533` 已證明 Eve / Hermes local 可產出可讀方案 comment，完成後回 paused/manual，且使用者確認內容方向 OK。
- 開源回報路徑：GitHub issue form、PR checklist、CONTRIBUTING、SECURITY 與文件試讀模板。

## 仍需保留 gate

- 正式 runtime skill 使用：`AI-98530` 是 Sandbox/Test 證據；正式員工或正式專案仍需另外安全驗收。
- 正式 Hermes / local model 任務：`AI-98533` 是 Sandbox/Test 證據；正式任務仍需新的具體 issue、具體 agent 與逐字一次性授權。
- 文件真人試讀：中文 UI 對照與安全提醒已由目前使用者確認清楚；英文文件仍需要英文讀者或熟悉英文的使用者回饋。
- Hermes / local model 下一次喚醒：仍需新的具體 issue、具體 agent 與逐字一次性授權。

## 安全停手線

- 不要貼 API key、token、密碼、完整 `.env`、完整 log、私密路徑或正式資料。
- 不要刪資料庫、手動刪 lock file，或移除不了解的本機檔案。
- 不要把 issue、PR、文件檢查或試讀回饋當成 Hermes 安裝或喚醒授權。
- 不要在 Sandbox/Test 邊界不清楚前按 Run now、啟用 schedule trigger 或喚醒模型。

## 建議試用流程

1. 跑 `pnpm run office:verify`。
2. 打開 `http://localhost:5173/AI/office`。
3. 先看檢查清單與開源導覽，再按任何會改資料的按鈕。
4. 如果卡住，用 `.github/ISSUE_TEMPLATE/virtual-office.yml` 或 Office 裡的 `複製 issue 回報`。
5. 如果只是試讀文件，用 `複製證據紀錄` 記錄是否看懂第一步與安全停手線。

## 希望收到的回饋

- 作業系統，以及是否第一次使用 Paperclip / agent / 本地模型。
- Backend / Frontend 狀態。
- 卡住步驟與短錯誤摘要。
- 看不懂的句子、按鈕或流程。
- 任何讓你誤以為應該貼密鑰、刪資料庫、按 Run now、啟用排程或喚醒 Hermes 的地方。
