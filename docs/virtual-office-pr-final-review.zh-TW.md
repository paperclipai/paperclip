# Virtual Office PR 最終人工檢查

這份文件用在真的開 PR 前最後一輪。它把目前 Virtual Office 開源試用包分成「應該進 PR」、「只留本機」、「需要人工看一眼」三區。

## 目前適合進 PR 的檔案群組

### 1. Virtual Office UI

- `ui/src/pages/VirtualOffice.tsx`
- `ui/src/App.tsx`
- `ui/src/App.test.tsx`
- `ui/src/components/AppHealthErrorPage.tsx`
- `ui/src/components/CloudAccessGate.tsx`
- `ui/src/components/RoutineRunVariablesDialog.tsx`
- `ui/src/components/Sidebar.tsx`
- `ui/src/pages/NewAgent.tsx`
- `ui/src/pages/ProjectDetail.tsx`
- `ui/src/pages/RoutineDetail.tsx`
- `ui/src/pages/Routines.tsx`
- `ui/src/lib/project-workflow-map.ts`
- `ui/src/lib/project-workflow-map.test.ts`
- `ui/src/lib/virtual-office-routine.ts`
- `ui/src/lib/virtual-office-routine.test.ts`
- `ui/public/virtual-office/office-reference.png`

### 2. 後端安全與 local-model gate

- `packages/adapter-utils/src/server-utils.ts`
- `packages/adapter-utils/src/server-utils.test.ts`
- `packages/adapters/claude-local/src/server/prompt-cache.ts`
- `packages/db/src/migration-runtime.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/validators/agent.ts`
- `server/src/adapters/registry.ts`
- `server/src/index.ts`
- `server/src/routes/agents.ts`
- `server/src/routes/issues.ts`
- `server/src/services/heartbeat.ts`
- `server/src/services/recovery/service.ts`
- `server/src/__tests__/*.test.ts`

### 3. 預覽、驗證、Hermes bridge 工具

- `package.json`
- `.gitignore`
- `scripts/open-virtual-office.cmd`
- `scripts/start-virtual-office-preview.ps1`
- `scripts/watch-virtual-office-preview.ps1`
- `scripts/check-virtual-office-acceptance.mjs`
- `scripts/check-virtual-office-doc-links.mjs`
- `scripts/check-virtual-office-render-smoke.mjs`
- `scripts/capture-virtual-office-pr-screenshots.mjs`
- `scripts/check-hermes-production-wakeup-preflight.ts`
- `scripts/check-hermes-runtime-skill-preflight.ts`
- `scripts/hermes-ollama-bridge.mjs`
- `scripts/start-hermes-ollama-bridge.ps1`
- `scripts/hermes-wsl-bridge.cs`
- `scripts/hermes-wsl-query-helper.py`
- `scripts/hermes-wsl.cmd`
- `scripts/build-hermes-wsl-bridge.ps1`

### 4. 公開文件與 GitHub 入口

- `README.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `.github/PULL_REQUEST_TEMPLATE.md`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/ISSUE_TEMPLATE/virtual-office.yml`
- `docs/virtual-office-*.md`

## 不要進 PR

以下應只留本機或被 `.gitignore` 排除：

- `VIRTUAL_OFFICE_PROGRESS.md`
- `docs/virtual-office-current-handoff.zh-TW.md`
- `.paperclip-dev-config.json`
- `.virtual-office-preview-status.json`
- `.virtual-office-stability-report.json`
- `.hermes-ollama-bridge-status.json`
- `.paperclip-dev*.log`
- `paperclip-dev*.log`
- `.hermes-ollama-bridge*.log`
- `.paperclip-local/`
- `scripts/hermes-wsl.exe`
- `docs/virtual-office-screenshots/`
- 任何 `.env`、API key、token、密碼、完整 log、私有 URL、正式資料或未授權資料。

`docs/virtual-office-screenshots/` 若再次出現，代表截圖被放錯位置；請移到 `.paperclip-local/virtual-office-pr-screenshots/` 或直接刪除。

## 需要人工看一眼

### 截圖

- `pnpm run office:pr-screenshots` 已能產生完整 Office 工作台截圖。
- 截圖仍必須人工檢查後再附 PR。
- 如果側欄有 `live` badge、私人員工名、私人任務名，請不要直接附原圖；改用裁切圖或重新準備乾淨 demo 資料。
- PR 文字要說明截圖是 local preview evidence，不是正式資料。

### 英文文件

- 英文文件已通過自動連結與基本可讀性檢查。
- 仍建議由母語或流利英文讀者看過後，再把英文文件 gate 說成完全完成。

### ROADMAP 關係

已讀 `ROADMAP.md`。這個 PR 會碰到 Skills Manager、Scheduled Routines、local/bring-your-own agent 等方向，但目前定位是：

- 開源試用工作台。
- 新手可視化操作層。
- 安全 gate 與文件外殼。
- Sandbox/Test 證據。

不要在 PR 裡宣稱已完成 roadmap 核心功能。

### PR 大小

這會是一個大 PR。若 reviewer 希望拆分，優先拆成：

1. UI workbench。
2. backend / Hermes safety gates。
3. preview and verification tools。
4. open-source docs and GitHub templates。

目前建議先用單一 PR 草稿呈現，因為安全 gate、文件、驗收與 UI 是互相支撐的一包。

## 開 PR 前最後命令

```powershell
pnpm run office:verify
pnpm run office:pr-screenshots
git status --short
git status --ignored --short
```

若要檢查公開檔是否有本機路徑或密鑰，使用 `docs/virtual-office-public-commit-scope.zh-TW.md` 裡的安全檢查原則。

## 仍然不可跨過的線

開 PR、附截圖、回覆 reviewer、更新文件，都不是以下行為的授權：

- 安裝 Hermes。
- 按 Run now。
- 啟用 schedule trigger。
- 啟用 heartbeat scheduler。
- 喚醒 Hermes 或 local model。
- 自動 retry、建立 recovery issue 或開 continuation。
- 讀取密鑰、完整 `.env`、正式資料或未授權資料。
