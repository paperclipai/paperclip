# Virtual Office 公開提交盤點

這份文件用在開源或建立 PR 前。目的不是重新描述所有功能，而是確認哪些檔案適合放上 GitHub、哪些只留在本機、以及最後提交前要做哪些安全檢查。

## 可以公開提交

以下類型通常可以放進公開 PR，但仍需先跑驗證：

- Virtual Office UI 與相關測試。
- Office 參考圖片與公開靜態素材，例如 `ui/public/virtual-office/office-reference.png`。
- 預覽與健康檢查工具，例如 `office:restart`、`office:check`、`office:verify`、render smoke。
- 公開新手文件、開源導覽、回報流程、PR 審查流程、維護者 SOP。
- GitHub issue template、PR template、`CONTRIBUTING.md`、`SECURITY.md`。
- Hermes / local model 的安全 preflight、Sandbox/Test 驗證工具、一次性授權防線。
- Hermes Windows/WSL bridge 的原始碼與建置腳本。

## Source-first Hermes bridge

Hermes Windows/WSL bridge 採 source-first 方式開源：

- 提交：
  - `scripts/hermes-wsl-bridge.cs`
  - `scripts/hermes-wsl-query-helper.py`
  - `scripts/hermes-wsl.cmd`
  - `scripts/build-hermes-wsl-bridge.ps1`
- 不提交：
  - `scripts/hermes-wsl.exe`

使用者需要時可自行建置：

```powershell
pnpm run hermes:wsl-bridge:build
```

可選設定：

```powershell
$env:HERMES_WSL_DISTRO="Ubuntu"
$env:HERMES_WSL_PATH="hermes"
```

如果 Hermes 不在 WSL 的 PATH 裡，`HERMES_WSL_PATH` 可以改成使用者自己的 WSL 路徑，例如 `/home/<wsl-user>/.local/bin/hermes`。不要把自己的真實 API key、token、完整 `.env` 或私有路徑放進文件範例。

## 不要公開提交

以下檔案或內容只應留在本機：

- `VIRTUAL_OFFICE_PROGRESS.md`
- `docs/virtual-office-current-handoff.zh-TW.md`
- `.paperclip-dev-config.json`
- `.virtual-office-preview-status.json`
- `.virtual-office-stability-report.json`
- `.hermes-ollama-bridge-status.json`
- `.paperclip-dev*.log`
- `paperclip-dev*.log`
- `.hermes-ollama-bridge*.log`
- `scripts/hermes-wsl.exe`
- 任何 `.env`
- API key、token、密碼、完整 log、私有 repo URL、內網 URL、正式資料、客戶資料、個人資料。

## 最後提交前檢查

開源前至少確認：

1. 跑過：

```powershell
pnpm run office:verify
```

2. 檢查工作樹：

```powershell
git status --short
git status --ignored --short
```

3. 確認本機狀態檔、log、`.env`、`scripts/hermes-wsl.exe` 沒有被提交。
4. 搜尋公開檔案中是否殘留個人路徑、私有 URL、API key、token、密碼或完整 `.env`。
5. 確認 release notes 沒有把 Sandbox/Test 證據說成正式 Hermes / local model 授權。
6. 確認 issue template、PR template、`CONTRIBUTING.md`、`SECURITY.md` 都保留安全停手線。
7. 參照 `docs/virtual-office-pr-submission-plan.zh-TW.md` 或 `docs/virtual-office-pr-submission-plan.en.md` 整理 PR 說明，並依照 `docs/virtual-office-pr-screenshot-evidence.zh-TW.md` 或 `docs/virtual-office-pr-screenshot-evidence.en.md` 檢查截圖。
8. 最後依照 `docs/virtual-office-pr-final-review.zh-TW.md` 或 `docs/virtual-office-pr-final-review.en.md` 做人工檢查。

## 安全停手線

任何公開 issue、PR、文件回饋或試讀都不是以下行為的授權：

- 安裝 Hermes。
- 按 Run now。
- 啟用 schedule trigger。
- 啟用 heartbeat scheduler。
- 喚醒 Hermes 或 local model。
- 自動 retry、建立 recovery issue 或開 continuation。
- 讀取密鑰、完整 `.env`、正式資料或未授權資料。

正式 Hermes / local model wake-up 仍需指定 issue、指定 agent、明確允許範圍，以及新的逐字一次性授權。
