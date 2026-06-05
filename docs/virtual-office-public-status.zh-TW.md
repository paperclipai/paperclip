# Virtual Office 公開狀態摘要

這份文件是準備放上 GitHub 的公開狀態摘要。它只保留可公開的進度、驗收狀態與安全邊界，不包含本機絕對路徑、私人帳號、完整 log、密鑰、`.env`、正式資料或個人工作紀錄。

較細的開發過程仍保留在本機紀錄中，例如 `VIRTUAL_OFFICE_PROGRESS.md` 與 `docs/virtual-office-current-handoff.zh-TW.md`。這些檔案不應直接作為公開發布素材。

## 開源前最終摘要

Virtual Office 目前可作為 Paperclip 上的新手友善 2.5D 工作台試用。已完成的主線包含：

- Office UI：AI 員工、skills、專案、工作流、會議、Routine / schedule 安全狀態與檢查清單。
- 預覽穩定：`office:restart`、`office:check`、`office:verify`、render smoke、60 分鐘穩定性測試與 3/3 Windows 重開機驗證。
- Sandbox/Test Hermes 證據：`AI-98530` 證明 runtime capability keys 可被 Hermes 看見；`AI-98533` 證明普通 Sandbox/Test 方案任務可由 Eve / Hermes local 產出可讀 comment，完成後回 paused/manual。
- 開源回報路徑：GitHub issue form、PR template、CONTRIBUTING、SECURITY、feedback triage、first contribution、PR review 與 maintainer daily SOP。
- 公開文件：中英文入門、快速啟動、開源導覽、發布檢查表、Go / Pause SOP、release notes draft 與 routine safety notes。

目前仍保留兩條不可越線的 gate：

- 英文文件真人回饋 gate：英文文件已通過自動檢查，但仍需要英文讀者或熟練英文使用者回饋語氣、自然度與中文 UI 對照是否足夠清楚。
- 正式 Hermes / local model wake-up gate：Sandbox/Test 證據不能延伸成正式授權。任何正式喚醒仍需具體 issue、具體 agent 與新的逐字一次性授權。

## 目前可公開說明

- 2.5D Virtual Office UI 已可用來查看 AI 員工、skills、專案、工作流、會議與安全狀態。
- 新手操作檯提供啟動檢查、端到端沙盒、檢查清單、文件回饋、開源回報與 Hermes / local model gate。
- `pnpm run office:verify` 會整合 UI typecheck、驗收清單同步、文件連結檢查、預覽健康檢查與 render smoke。
- Routine / schedule 已有安全門：草稿、trigger、Run now 都和 Sandbox/Test 邊界分開。
- Hermes Sandbox/Test runtime capability-key proof 已由 `AI-98530` 驗證。
- 普通 Sandbox/Test 方案任務已由 `AI-98533` 驗證：Eve / Hermes local 成功留下方案設計 comment，完成後回到 paused/manual，沒有 active/live run、retry、recovery 或 continuation，使用者確認內容方向 OK。
- 中文文件已由目前使用者確認 UI 對照與安全提醒清楚；英文文件語氣仍保留給英文母語或英文使用者回饋後再優化。

## 仍需保守說明

- Sandbox/Test 成功不等於正式專案授權。
- 任何下一次 Hermes / local model 喚醒仍需要新的逐字一次性授權。
- GitHub issue、PR、文件檢查、試讀回報或一句「請繼續」都不是 Run now、schedule trigger、heartbeat scheduler 或模型喚醒授權。
- 若遇到 529、timeout、adapter failed、模型 API connection error 或其它 transient error，只記錄失敗並停下；不自動 retry、不建立 recovery issue、不開 continuation。
- 正式資料、正式投資建議、正式交易資料與任何密鑰都不應放入沙盒任務、issue、公開回報或文件。

## 可公開文件

可作為 GitHub 公開入口的文件：

- `README.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `.github/ISSUE_TEMPLATE/virtual-office.yml`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `docs/virtual-office-public-status.zh-TW.md`
- `docs/virtual-office-getting-started.zh-TW.md`
- `docs/virtual-office-getting-started.en.md`
- `docs/virtual-office-quick-start.zh-TW.md`
- `docs/virtual-office-quick-start.en.md`
- `docs/virtual-office-open-source-readme.zh-TW.md`
- `docs/virtual-office-open-source-readme.en.md`
- `docs/virtual-office-acceptance-checklist.zh-TW.md`
- `docs/virtual-office-startup-sop.zh-TW.md`
- `docs/virtual-office-startup-sop.en.md`
- `docs/virtual-office-routine-safety.zh-TW.md`
- `docs/virtual-office-routine-safety.en.md`
- `docs/virtual-office-hermes-sop.zh-TW.md`
- `docs/virtual-office-release-checklist.zh-TW.md`
- `docs/virtual-office-release-checklist.en.md`
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

## 提交範圍盤點

準備 GitHub PR 或開源分享時，建議把目前變更分成三類檢查。

### 可公開候選

- Virtual Office UI 與新手操作檯：2.5D 辦公室、檢查清單、預覽狀態、安全提醒、Sandbox/Test workflow 與 routine/schedule 防誤觸。
- 後端與安全閘：adapter runtime capability、Hermes/local-model preflight、one-time authorization、transient error 不自動 retry / recovery / continuation。
- 預覽穩定工具：`office:restart`、`office:check`、`office:verify`、render smoke、狀態報告與開機復原 SOP。
- 公開文件與回報路徑：README、Getting Started、Quick Start、Open-source overview、Release checklist、Go/Pause SOP、issue form、PR template、CONTRIBUTING、SECURITY、feedback triage 與 maintainer SOP。
- 靜態視覺素材：`ui/public/virtual-office/office-reference.png`。

### 需要維護者確認

- Hermes Windows/WSL bridge 採 source-first：提交 `scripts/hermes-wsl-bridge.cs`、`scripts/hermes-wsl-query-helper.py`、`scripts/hermes-wsl.cmd` 與 `scripts/build-hermes-wsl-bridge.ps1`；`scripts/hermes-wsl.exe` 是本機建置產物，已加入 `.gitignore`，使用者可用 `pnpm run hermes:wsl-bridge:build` 自行編譯。
- Hermes/Ollama bridge scripts 屬於 Sandbox/Test 與本地模型前置工具；公開時要保留「不填密鑰、不自動喚醒、不處理正式資料」的說明。
- 開源前若要正式宣稱英文文件完成，仍需要英文讀者或熟練英文使用者回饋。

### 不可公開提交

這些檔案是本機狀態、私密設定或進度日誌，只能保留在本機，不應放進 PR：

- `VIRTUAL_OFFICE_PROGRESS.md`
- `docs/virtual-office-current-handoff.zh-TW.md`
- `.paperclip-dev-config.json`
- `.virtual-office-preview-status.json`
- `.virtual-office-stability-report.json`
- `.hermes-ollama-bridge-status.json`
- `.paperclip-dev*.log`、`paperclip-dev*.log`、`.hermes-ollama-bridge*.log`
- 任何 `.env`、API key、token、密碼、私密 URL、完整 log、正式客戶資料或正式公司資料。

## 不應公開提交

以下內容不應放上 GitHub：

- `VIRTUAL_OFFICE_PROGRESS.md`
- `docs/virtual-office-current-handoff.zh-TW.md`
- `.paperclip-dev-config.json`
- `.virtual-office-preview-status.json`
- `.virtual-office-stability-report.json`
- `.paperclip-dev*.log`
- `paperclip-dev*.log`
- `.hermes-ollama-bridge*.log`
- 任何 `.env`
- API key、token、密碼、私密 URL、內網 URL、私密 repo URL、本機帳號路徑、正式客戶資料或正式公司資料

## 發布前最後檢查

1. 跑 `pnpm run office:verify`。
2. 檢查 `git status --ignored --short`，確認本機設定與 log 都仍被 ignore。
3. 掃描公開文件中是否出現 `C:\Users\<name>`、私密 repo URL、內網 URL、API key、token、密碼、完整 `.env` 或正式資料。
4. 確認 release notes 沒有暗示已授權正式 Hermes/local model、Run now、schedule trigger 或 heartbeat scheduler。
5. 確認 GitHub issue form、PR template、CONTRIBUTING 與 SECURITY 都提醒不要貼敏感資料。
