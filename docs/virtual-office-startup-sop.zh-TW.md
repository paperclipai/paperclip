# Virtual Office 開機預覽復原 SOP

這份文件用來處理「開機後 Virtual Office 預覽打不開、後端健康檢查失敗、或頁面卡住」的情況。目標是讓每次重新開機後，都能用同一套方式恢復，不用重新猜問題。

## 先看兩個網址

1. 前端畫面：
   `http://localhost:5173/AI/office`

2. 後端健康檢查：
   `http://127.0.0.1:3100/api/health`

判斷方式：

- 前端可開、後端健康檢查失敗：通常是後端或 embedded Postgres 沒起來。
- 後端健康檢查正常、前端打不開：通常是前端預覽服務沒起來。
- 兩個都不正常：先重啟後端，再重啟前端。

## 穩定啟動原則

後端預覽先用這些設定：

- `HEARTBEAT_SCHEDULER_ENABLED=false`
  避免 Hermes 或本地模型尚未設定完成時自動醒來，產生 recovery issues。

- `PAPERCLIP_CONFIG=C:\path\to\paperclip\.paperclip-dev-config.json`
  使用固定的 embedded Postgres port `54331`，避開開機後殘留 port 狀態。

`.paperclip-dev-config.json` 必須是完整 Paperclip config，不只是一小段 database 設定。原因是：

- migration-status 可以讀簡化 database config。
- Paperclip server 會用較完整的 schema 驗證 config。
- 如果 server 覺得 config 無效，會退回預設 port `54329`，造成 migration-status 使用 `54331`、server 使用 `54329` 的分裂狀態。

如果看到 logs 同時出現 `54331` 與 `54329`，先檢查 `.paperclip-dev-config.json` 是否仍是完整格式，再處理 shared memory 或 lock file。

## 建議啟動順序

1. 先啟動後端。
2. 等 30-45 秒。
3. 檢查 `http://127.0.0.1:3100/api/health`。
4. 後端正常後，再啟動前端。
5. 打開 `http://localhost:5173/AI/office`。

## 快速方式：使用輔助腳本

已新增 Windows 用輔助腳本：

`scripts/start-virtual-office-preview.ps1`

它會做這幾件事：

- 設定 `HEARTBEAT_SCHEDULER_ENABLED=false`
- 使用 `.paperclip-dev-config.json`
- 檢查後端健康狀態，確認 health 回傳 `status: ok`
- 後端沒起來時啟動後端
- 檢查前端預覽頁
- 前端沒起來時啟動前端
- 顯示預覽 readiness 摘要，分別標示後端與前端是否可用
- 後端仍卡住時，列出 `3100`、`5173`、`54331` 的 port 佔用快照，方便判斷是後端、前端還是 embedded Postgres 卡住
- 每次檢查都會更新 `.virtual-office-preview-status.json`，保留後端、前端、port、lock file 與下一步建議，方便重開機後回看或貼給 Codex 判斷

只檢查、不啟動任何服務：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-virtual-office-preview.ps1 -CheckOnly
```

也可以用較短的專案指令：

```powershell
pnpm run office:check
```

如果 `office:check` 顯示 Frontend OK，但畫面看起來是黑屏、空白或沒有真正載入 Office 內容，請再跑真實渲染檢查：

```powershell
pnpm run office:render-smoke
```

這會開一個乾淨的 headless Edge/Chrome，實際載入 `http://localhost:5173/AI/office`，確認 React root 有內容、頁面文字含有 Office 關鍵字。`pnpm run office:verify` 也會自動包含這個檢查。

一般復原可用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-virtual-office-preview.ps1
```

較短指令：

```powershell
pnpm run office:start
```

如果明確需要先停掉舊的 Paperclip dev service 再重啟，可用：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-virtual-office-preview.ps1 -Restart
```

較短指令：

```powershell
pnpm run office:restart
```

使用 `-Restart` 前要確認沒有正在保存資料、建立任務或同步 skills。

`-CheckOnly` 和 `-Restart` 不要一起使用；一個是只看狀態，一個是明確重啟。

## 本地 AI 一鍵啟動與檢查

如果你要測 Virtual Office 搭配 Hermes / Ollama，本地 AI stack 需要同時確認：

- Virtual Office backend / frontend 可用。
- Windows Ollama 已啟動。
- `qwen2.5:14b` 模型存在。
- Hermes Ollama bridge 可從 WSL 讀到 `/v1/models`。
- Eve 仍是 `paused/manual`。
- 測試 issue 沒有 active run 或 live run。

可以使用：

```powershell
pnpm run office:local-ai-start
```

這會啟動或檢查 Office preview、Ollama 與 Hermes Ollama bridge，並更新本機狀態報告：

```text
.virtual-office-local-ai-status.json
```

只檢查、不啟動服務：

```powershell
pnpm run office:local-ai-check
```

明確需要重啟 preview 與 bridge 時：

```powershell
pnpm run office:local-ai-restart
```

這些指令不會喚醒 Eve 或任何 Hermes agent，不會 Run now，不會開 schedule trigger，也不會打開 heartbeat scheduler。若本地 AI stack 顯示 READY，仍然只代表環境可用；真正 Hermes/local model wake-up 仍需要新的逐字一次性授權。

如果畫面出現 `Restart Required`，代表後端偵測到檔案已更新但目前服務仍是舊版本。這時使用 `pnpm run office:restart`，helper 會清理 Paperclip 後端殘留程序並強制重新啟動，不會只因 health 還有回應就沿用舊後端。

## 預覽狀態報告

每次執行 `pnpm run office:check`、`pnpm run office:start` 或 `pnpm run office:restart` 後，helper 會更新：

```text
.virtual-office-preview-status.json
```

這份檔案是本機診斷報告，不適合提交到開源 repo，因此已加入 `.gitignore`。

報告裡最重要的是：

- `backendOk`：後端資料服務是否正常。
- `frontendOk`：Office 預覽頁是否能開。
- `embeddedPostgresLockFile.exists`：embedded Postgres lock file 是否存在。
- `stuckBackendProcesses`：是否還有可疑的 Paperclip 後端殘留程序。
- `portOwnership`：`3100`、`5173`、`54331` 目前由誰監聽。
- `nextAction`：下一步是可以開 Office、先重啟後端，或只要重啟前端。

如果下次開機又卡住，可以先跑 `pnpm run office:check`，再請 Codex 查看 `.virtual-office-preview-status.json`。

## 開機安全包

Office 新手操作檯的 `預覽服務` 區塊有 `複製開機安全包`。

這個按鈕會一次整理：

- 每日開工前安全檢查
- 預覽卡住時貼給 Codex 的求助文字
- `.virtual-office-preview-status.json` 覆盤模板
- 預覽故障決策表

建議使用時機：

1. 重開機後先跑 `pnpm run office:check`。
2. 打開 `http://localhost:5173/AI/office`。
3. 在 `預覽服務` 區塊按 `複製開機安全包`。
4. 把 `.virtual-office-preview-status.json` 的欄位值補進模板。
5. 如果仍卡住，把整包文字貼給 Codex。

安全邊界：

- `office:check` 沒通過前，不要建立、同步、保存、停用、Run now 或喚醒 Hermes。
- 看到 lock file 時不要手動刪 `postmaster.pid`，先照本 SOP 重啟或重開 Windows。
- 不確定時先求助，不要直接刪資料庫資料夾。

如果要一次確認 UI 型別、驗收清單、文件連結與預覽健康，可以跑：

```powershell
pnpm run office:verify
```

## 前端 blocked 但後端 OK 時

如果 helper 顯示：

```text
Backend health: OK
Frontend page:  blocked
Next action: restart the frontend preview only; the backend is ready.
```

這通常代表後端與資料庫已經健康，只是前端預覽頁沒有回應。處理順序：

1. 先不要刪資料庫、不要手動刪 `postmaster.pid`、不要喚醒 Hermes。
2. 執行 `pnpm run office:restart`，讓 helper 用固定方式重啟預覽服務。
3. 再跑一次 `pnpm run office:verify` 或 `pnpm run office:check`。
4. 只有看到 Backend OK / Frontend OK 後，才繼續 UI 或資料變更驗收。

## 瀏覽器分頁卡在錯誤頁時

有時候後端與前端都已經恢復正常，但 in-app browser 分頁曾經掉到 `data:` 錯誤頁，瀏覽器安全規則會拒絕後續自動點擊。這不是 Paperclip 後端壞掉，也不是資料庫壞掉。

建議順序：

1. 先跑 `pnpm run office:check`，確認 Backend OK 與 Frontend OK。
2. 如果兩邊都 OK，但畫面或自動操作仍被擋，手動重新整理 `http://localhost:5173/AI/office`。
3. 若重新整理仍卡住，關掉該預覽分頁，再開一個新的 `http://localhost:5173/AI/office`。
4. 在分頁恢復正常前，只做只讀檢查，不要用繞路方式去建立、同步、保存或暫停員工。

這條規則是為了保護本機測試資料：畫面還沒回到正常 Office 頁前，不把資料變更動作交給自動化工具硬做。

## 後端卡住時的復原順序

先不要急著重裝依賴或改設定。照這個順序處理：

1. 檢查後端健康狀態。
2. 如果健康檢查失敗，確認是否有舊的 Node 或 Postgres 還佔著 port。
3. 只清理確定屬於這個 Paperclip 預覽的背景程序。
4. 用固定設定重新啟動後端。
5. 等待 30-45 秒後再檢查健康狀態。

常見要檢查的 port：

- `3100`：Paperclip 後端
- `5173`：前端預覽
- `54331`：本專案使用的 embedded Postgres

## 我們目前使用過的穩定後端啟動方式

```powershell
$env:PATH='C:\path\to\.tools;' + $env:PATH
$env:HEARTBEAT_SCHEDULER_ENABLED='false'
$env:PAPERCLIP_CONFIG='C:\path\to\paperclip\.paperclip-dev-config.json'
Start-Process -FilePath 'node' -ArgumentList @('cli/node_modules/tsx/dist/cli.mjs','scripts/dev-runner.ts','dev') -WorkingDirectory 'C:\path\to\paperclip' -WindowStyle Hidden
```

健康檢查：

```powershell
Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3100/api/health' -TimeoutSec 10
```

## 我們目前使用過的穩定前端啟動方式

```powershell
$env:PATH='C:\path\to\.tools;' + $env:PATH
Start-Process -FilePath 'C:\path\to\.tools\pnpm.cmd' -ArgumentList @('--filter','@paperclipai/ui','dev','--','--host','localhost') -WorkingDirectory 'C:\path\to\paperclip' -WindowStyle Hidden
```

前端檢查：

```powershell
Invoke-WebRequest -UseBasicParsing 'http://localhost:5173/AI/office' -TimeoutSec 10
```

## 關機前建議

如果只是一般關機，通常不用做太多事。但若當天已經遇到過卡住，關機前建議：

1. 確認目前沒有正在建立任務、保存員工、同步 skills。
2. 關掉瀏覽器預覽頁面。
3. 下次開機時先不要急著開多個預覽服務，先用本 SOP 檢查後端健康狀態。
4. 如果當天曾看過 `Restart Required` 或 `data:` 錯誤頁，下次開機先開新的 Office 分頁，不要沿用舊錯誤分頁。

## 下次可以直接叫 Codex 做的事

可以直接說：

> 請依照 `docs/virtual-office-startup-sop.zh-TW.md` 幫我復原 Virtual Office 預覽。

更保守的版本：

> 請依照 `docs/virtual-office-startup-sop.zh-TW.md` 幫我檢查 Virtual Office 預覽，先只做健康檢查，不要刪資料庫，不要建立或修改資料。

Codex 會照這份順序檢查：

- 後端健康狀態
- 前端預覽狀態
- 是否有舊程序卡住
- 是否需要用固定 config 重啟
- 頁面是否能回到 `/AI/office`
- 是否適合使用 `scripts/start-virtual-office-preview.ps1`

## 不建議的處理方式

- 不要一開始就刪資料庫資料夾。
- 不要一開始就重裝依賴。
- 不要同時開很多個後端預覽。
- 不要在 Hermes 尚未設定好前打開 heartbeat。

這些動作可能讓問題變大，或讓 demo 資料變得更難追蹤。
## embedded Postgres shared memory 卡住時

如果後端錯誤出現 `pre-existing shared memory block is still in use`，通常代表上一輪 embedded Postgres 或 migration-status 沒有完全退乾淨。

固定處理方式：

1. 先不要重複按建立、同步、保存或停用。
2. 停掉 Paperclip 專屬的 `dev-runner.ts dev`、`src/migration-status.ts` 與 `@embedded-postgres` 殘留程序。
3. 等 3 秒後重新啟動後端。
4. 再檢查 `http://127.0.0.1:3100/api/health`。

`scripts/start-virtual-office-preview.ps1` 已內建這個清理步驟；當後端不健康且不是 `-CheckOnly` 模式時，會先清理 Paperclip 後端殘留再啟動。

### 沒有 lock file，但 Windows 還顯示 unknown PID 佔用時

如果同時看到這些現象，代表已經不是一般的「舊程序沒關乾淨」：

- 後端錯誤仍是 `pre-existing shared memory block is still in use`
- `.virtual-office-preview-status.json` 顯示 `embeddedPostgresLockFile.exists: false`
- `54331` 仍被某個 PID 監聽，但工作管理員、`tasklist` 或程序查詢都找不到該 PID
- 重跑 `pnpm run office:restart` 後仍無法讓 `http://127.0.0.1:3100/api/health` 回到 `status: ok`

這種狀況通常是 Windows 或 embedded Postgres 的共享記憶體狀態沒有完全釋放。保守處理方式是：

1. 不要刪除 `C:\Users\<you>\.paperclip\instances\default\db`。
2. 不要手動刪 `postmaster.pid`、資料庫資料夾或任何資料檔案。
3. 關閉預覽頁與背景開發服務。
4. 重新啟動 Windows。
5. 重開機後先執行 `pnpm run office:check`。
6. 如果後端仍未恢復，再執行 `pnpm run office:restart`。

這個分支的判斷重點是：沒有可安全停止的明確程序、也沒有 lock file 可作為依據時，不用硬拆資料庫；先讓 Windows 釋放共享記憶體。

### 看到 54329 / 54331 分裂時

如果 helper 顯示 54331，但後端前景 log 顯示：

```text
Using embedded PostgreSQL ... port=54329
```

請先不要繼續重啟。這通常代表後端沒有接受目前的 `PAPERCLIP_CONFIG`，或 config 格式不符合後端 schema。

固定處理方式：

1. 檢查 `.paperclip-dev-config.json` 是否有 `$meta`、`database`、`logging`、`server`、`telemetry` 等區塊。
2. 確認 `database.embeddedPostgresPort` 是 `54331`。
3. 停掉卡住的 Paperclip 後端與 migration-status 程序。
4. 確認 `54331` 沒有殘留監聽後，再執行 `pnpm run office:restart`。
5. 復原後執行 `pnpm run office:check`，確認 Backend OK / Frontend OK。

這個問題不是資料遺失，也不是前端壞掉；它是 dev helper 與後端主服務讀到不同設定造成的啟動分裂。
## postmaster.pid 還在時

如果 helper 顯示 embedded Postgres lock file exists，代表後端資料庫可能還有殘留鎖或 Windows shared memory 沒釋放。

請先不要手動刪除資料庫資料夾、`postmaster.pid` 或任何 `C:\Users\<you>\.paperclip\instances\default\db` 內的檔案。這些檔案連著本機測試資料，只有在明確決定做資料庫復原時才處理。

建議順序：
1. 先執行 `pnpm run office:restart`。
2. 再開 `http://127.0.0.1:3100/api/health` 確認是否回到 `status: ok`。
3. 如果仍然顯示 shared memory 或 lock file，關閉預覽後重新啟動 Windows。
4. 重開機後再執行 `pnpm run office:start`。
5. 若仍失敗，把 helper 顯示的 `Backend recovery hints` 貼回驗收紀錄，讓 Codex 依照那段資訊繼續排查。
## 2026-05-09 startup fix note

今天確認開機後端卡住的主要原因不是資料遺失，而是 Windows 上 embedded Postgres 和 migration preflight 在啟動時交錯，會留下 `pre-existing shared memory block is still in use`、不可見 PID、或後端 3100 已啟動但資料庫 54332 已停止的狀態。

已調整處理方式：
- `office:restart` 會清掉 `src/index.ts`、`migration-status.ts`、`dev-runner.ts dev` 與 embedded Postgres 的殘留程序。
- 預覽 helper 改成直接啟動 `@paperclipai/server` 的 `src/index.ts`，避免 `dev-runner` 預檢重複啟停 embedded Postgres。
- migration 檢查與 server 啟動都會等待 embedded Postgres 真正接受連線；如果 migration 檢查啟動失敗，會先停掉它自己開的資料庫程序。
- helper 的 port snapshot 會讀 `.paperclip-dev-config.json` 的 `database.embeddedPostgresPort`，目前是 `54332`，並同時列出舊的 `54331` 方便排查。

開機後建議流程維持：
```powershell
cd C:\path\to\paperclip
$env:PATH='C:\path\to\.tools;' + $env:PATH
pnpm run office:restart
pnpm run office:verify
```

2026-05-09 驗證結果：`pnpm run office:verify` 通過；Backend OK、Frontend OK，UI 摘要檢查表 128/131，Markdown 明細檢查表 182/186，文件連結檢查 0 問題。

## 長時間穩定性檢查

只有在 `pnpm run office:verify` 已經通過，而且 Office 頁面可以正常打開後，才做這個檢查。

```powershell
pnpm run office:stability
```

這個 watcher 會確認：

- 後端 health：`http://127.0.0.1:3100/api/health`
- Office 頁面：`http://localhost:5173/AI/office`
- heartbeat scheduler 是否仍為 `false`

預設會跑 120 分鐘，每 60 秒檢查一次，最後寫出 `.virtual-office-stability-report.json`，方便開源前覆盤。

開發中如果只想快速試跑工具本身，可以用：

```powershell
powershell -ExecutionPolicy Bypass -File ./scripts/watch-virtual-office-preview.ps1 -DurationMinutes 1 -IntervalSeconds 5
```

這個工具通過只代表「檢查工具可用、這段抽樣期間預覽可連線」。真正開源前仍要人工記錄 2 到 3 次 Windows 重開機，以及 1 到 2 小時的實際閒置長測。

### 開源前穩定性證據表

不要為每一次重開機或每一次長測新增新的流程卡。開源前只保留這一張表，累積到足夠證據再更新 release checklist。

| 類型 | 次數 / 時長 | 開始時間 | 結束時間 | `office:restart` | `office:verify` | `office:stability` | 結論 | 備註 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows 重開機 | 1 / 3 |  |  | PASS / FAIL | PASS / FAIL | 不適用 | PASS / FAIL |  |
| Windows 重開機 | 2 / 3 |  |  | PASS / FAIL | PASS / FAIL | 不適用 | PASS / FAIL |  |
| Windows 重開機 | 3 / 3 |  |  | PASS / FAIL | PASS / FAIL | 不適用 | PASS / FAIL |  |
| 閒置長測 | 60 到 120 分鐘 |  |  | 已完成 / 不適用 | PASS / FAIL | PASS / FAIL | PASS / FAIL |  |

通過標準：

- 每次重開機後 Backend OK、Frontend OK。
- heartbeat scheduler 仍為 `false`。
- 沒有 active Hermes run、沒有 recovery chain 殘留、沒有正式資料任務被喚醒。
- `.virtual-office-stability-report.json` 顯示長測期間 backend/frontend 持續可連線。
- 若其中一項失敗，只記錄失敗原因與修正，不把穩定性 gate 標成完成。
