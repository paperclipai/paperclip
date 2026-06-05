# Virtual Office 開源導覽草稿

Virtual Office 是建立在 Paperclip 之上的 2.5D 新手友善工作台。它把 AI 員工、skills、專案、工作流、會議紀錄與排程安全狀態放進一個比較像「個人 AI 公司」的畫面，讓不會寫程式的人也能逐步開始使用 agent。

這不是商轉 SaaS 模板，也不是要取代 Paperclip 原本的資料模型。它是一層比較視覺化、比較適合新手理解的操作介面，幫使用者在看懂 agent、issue、project、skill、routine 之間的關係之前，也能先安全地開始。

## 目前狀態

目前 UI、文件、預覽復原流程、開源回報路徑、Hermes Sandbox/Test runtime capability key 真測，以及普通 Sandbox/Test 方案任務都已可供覆盤，但理想版開源前仍保留幾個 gate：

- runtime skill loading 已在 `AI-98530` 的 Sandbox/Test issue 中由 Hermes 回覆證明；正式員工或正式專案仍需另行安全驗收。
- 普通 Sandbox/Test 方案任務已在 `AI-98533` 由 Eve / Hermes local 成功產出 comment，使用者確認內容方向 OK；這可作為新手安全流程範例，不代表後續任務可沿用授權。
- 中文 UI 對照與安全提醒已由目前使用者確認清楚；英文文件仍需要真人試讀證據，語氣保留給英文母語或英文使用者回饋後再優化。
- 任何下一次 Hermes / local model 喚醒仍需新的 Sandbox/Test issue 與新的逐字一次性授權，不能從 issue、PR 或文件檢查推定。

## 適合誰

- 從單一 AI 助手慢慢走向個人 AI 團隊的人。
- 想嘗試 Hermes、Ollama、vLLM、LM Studio 或其它本地模型的人。
- 想用「員工、技能、專案、會議、排程」來管理 AI 工作的人。
- 想分享新手友善開源流程，而不是做商業產品的人。

## 目前已能使用

- 在 2.5D 辦公室裡查看員工、專案、工作流、會議與最近活動。
- 用新手操作檯建立員工、配置 skills、管理員工、建立工作流與開會討論。
- 使用 PM、工程、測試、設計、研究、資料、營運與風險等角色模板。
- 建立工作流前先預覽五階段、專案主管、階段負責人與上下游或平行關係。
- 讓會議討論留下可覆盤的背景、決策、未解問題與下一步。
- 在 Office 內查看驗收檢查表，或複製 Markdown 給文件、issue、進度紀錄使用。
- 以 `複製技能同步復查` 只讀確認 Sandbox 測試員工的 starter skills 保存狀態，不同步、不建立 issue、不喚醒模型。
- 用 `複製開源試讀邀請` 邀請朋友或 GitHub 讀者試讀文件，回報是否看懂第一步、安全界線與卡住位置。
- 用 `複製試用回報` 收集真的打開預覽後的 OS、Backend/Frontend 狀態、卡住步驟與錯誤摘要；不要求貼密鑰、完整 log 或私密路徑。
- 用 `複製 issue 回報` 把試用回報整理成 GitHub issue，分流啟動、畫面、文件、Hermes 前置與安全疑慮；只貼短錯誤摘要，不貼密鑰或完整 log。
- 用 `複製成功範例` 查看 `AI-98533` 的 Sandbox/Test 成功流程：編輯不喚醒、逐字一次性授權、Eve/Hermes 留言、完成後回 paused/manual、人工確認內容方向 OK。
- GitHub 也有 `.github/ISSUE_TEMPLATE/virtual-office.yml`，開源後使用者可直接用欄位化 issue form 回報，並先勾選敏感資訊停手確認。
- `.github/ISSUE_TEMPLATE/config.yml` 會關閉空白 issue，並把讀者導向入門文件、發布檢查表、貢獻指南或 private security advisory。
- `CONTRIBUTING.md` 也補上 Virtual Office feedback 段落，說明好回報需要哪些資訊；若內容像安全漏洞或可能包含敏感資訊，請改看 `SECURITY.md`，不要開公開 issue。
- `.github/PULL_REQUEST_TEMPLATE.md` 也有 Virtual Office verification block，提醒相關 PR 要跑 `pnpm run office:verify`、人工檢查頁面/文件、同步驗收清單，並確認沒有安裝 Hermes、Run now、排程或喚醒模型。
- `docs/virtual-office-release-checklist.zh-TW.md` 與英文版提供開源發布前逐項核對，確認 README、issue form、PR template、CONTRIBUTING、SECURITY、驗收文件與停手線都準備好。
- `docs/virtual-office-release-decision.zh-TW.md` 與英文版提供對外分享前最後的 Go / Pause / Internal Only 判斷。
- `docs/virtual-office-release-notes-draft.zh-TW.md` 與英文版可作為第一次對外分享時的發布備註草稿。
- `docs/virtual-office-feedback-triage.zh-TW.md` 與英文版可在收到回報後協助分流預覽、文件、UI、Hermes 前置與安全通報。
- `docs/virtual-office-maintainer-daily.zh-TW.md` 與英文版可作為維護者每天開工、分流回報與收工前驗證的 SOP。
- `docs/virtual-office-feedback-to-work-items.zh-TW.md` 與英文版可把分流後的回報轉成文件、UI、驗收清單或安全處理工作項目。
- `docs/virtual-office-first-contribution.zh-TW.md` 與英文版可給第一次貢獻者照著做小範圍文件、UI 文字、檢查清單或開源導覽修正。
- `docs/virtual-office-pr-review.zh-TW.md` 與英文版可給維護者審查 Virtual Office PR 時確認範圍、驗證、文件/UI/檢查清單同步與安全停手線。
- 用 `複製回饋彙整` 將試讀意見整理成必修、建議修、可延後與安全風險。
- 用 `複製證據紀錄` 逐位留下試讀者背景、閱讀範圍、卡住原話與文件 gate 判斷依據。
- 用 `複製英文試讀包` 請英文讀者檢查英文語氣、中文 UI 對照與 Hermes / Run now 安全提醒。
- 查看 Routine / schedule 安全面板，並用安全三步驟先從 Sandbox/Test 草稿開始。

## 仍在改善

- skills 同步與 starter skill 建立的完整端到端驗收。
- 建立工作流後 blockers 與上下游關係的更完整實測。
- 真實會議 issue 裡使用者介入規則的完整驗收。
- 正式 Hermes 或其它本地模型任務的授權流程與穩定性觀察；Sandbox/Test 已通過，不代表正式任務可免授權。
- 英文文件語氣與完整度的人工作業回饋。

## 安全原則

Virtual Office 會盡量把「只看預覽」和「會改本機資料」分清楚。

以下動作會修改本機 Paperclip 資料：

- 建立工作流
- 建立會議任務
- 建立 starter skill
- 同步 skills
- 保存員工變更
- 停用員工
- 建立 routine
- 新增 routine trigger
- 手動 Run now

如果只是想看介面，請只開啟表單、預覽與檢查清單，不要按最後的建立、同步、保存、停用、Add trigger 或 Run now。

## Routine / 排程安全

Routine 可以讓 AI 員工定期整理進度、提醒阻塞或產生覆盤紀錄，但它也可能在未來自動建立工作或喚醒 agent。因此第一版採用保守策略：

- Office 主畫面只讀顯示 routine 狀態，不直接建立 routine。
- 預填 routine 只會產生 Sandbox/Test 草稿，仍需使用者手動按 Create routine。
- Virtual Office routine 在新增 trigger 前，需要先勾選 Sandbox/Test 安全確認。
- Virtual Office routine 在 Run now 前，也需要先勾選 Sandbox/Test 安全確認。
- Office 不會自動指派 Hermes、不會自動 Run now，也不會打開 heartbeat scheduler。

建議順序：

1. 先做草稿：只預填 Sandbox/Test routine。
2. 再過安全門：新增 trigger 或 Run now 前先確認專案、員工與目的。
3. 最後覆盤：測完查看 runs、active issues、recovery issues，再決定保留、調整、停用或刪除。

詳細說明在：

```text
docs/virtual-office-routine-safety.zh-TW.md
```

## 本地模型準備

在 Hermes 或其它本地模型接正式工作前，請先確認：

1. 本地模型服務已啟動。
2. Paperclip adapter 指向正確模型與端點。
3. 小型測試任務能確認 agent 可以讀任務、回覆、留下可覆盤紀錄。
4. 重複出現的 recovery issues 已先處理。
5. heartbeat 或其它自動喚醒只在設定穩定後才開啟。

預覽或開發期間建議保持 heartbeat 關閉，避免未完成的 agent 反覆執行。

要確認同步到員工身上的 skills 是否真的被本地模型執行時載入，請在 Office 的 `檢查清單` 裡按 `複製技能載入驗收`。這份模板只用 Sandbox/Test issue，並要求記錄 adapter 支援狀態、desired skills 是否保留，以及 agent 回覆中的 skill 使用證據。

Hermes 區塊的 `技能載入驗收準備度` 會先只讀檢查 adapter skills、starter skills 同步、Sandbox/Test 與下一步；條件未齊前不要建立 issue 或喚醒模型。

## 驗收追蹤

功能完成度記錄在：

```text
docs/virtual-office-acceptance-checklist.zh-TW.md
```

Office 頁面也有 `檢查清單` 按鈕，可以查看已驗證、部分完成、待開發與需人工驗收項目。

如果只想知道距離理想版還剩哪些 gate，可以在檢查清單裡按 `複製剩餘路線`。它會列出技能 runtime、文件人工閱讀、Hermes 沙盒喚醒與開源前穩定性驗收的最新狀態，不必貼出整份驗收清單。

如果準備開源或交付給別人試用，請先按 `複製交付判斷`。它會把目前狀態分成可交付、仍需證據與不可越線三類，提醒「可試用」不等於正式 Hermes 任務、正式 runtime skill 使用或真人文件試讀都已完成。

發布前請再按 `複製開源安全包`。它會提醒不要提交 `.paperclip-dev-config.json`、`.paperclip-dev*.log`、`paperclip-dev*.log`、`.virtual-office-preview-status.json` 或任何 `.env`，並確認文件入口、`pnpm run office:verify` 與 Hermes 停手線都清楚。

如果要把專案交接給下一位協作者，請按 `複製 Gate 交接`。它會列出最後 gate 的完成條件、目前阻塞原因與不可越線動作，避免誤把 UI 準備工具當成真人驗收或模型真喚醒。

如果只想知道今天下一步該做哪個，請按 `複製 Gate 決策`。它會把剩餘 gate 分成可安全做、先暫緩與授權後才做，讓新手不會把 Hermes 喚醒、Run now 或 schedule trigger 當成一般檢查。

如果想知道 Hermes 目前停在哪一階，請按 `複製授權總控`。它會把只讀準備、命令預覽、安裝陪同、設定檢查、沙盒喚醒與喚醒後覆盤整理成狀態卡；這不是安裝或喚醒授權。

如果 Hermes 已經在自己的設定位置填好 provider / model / API key，請按 `複製設定檢查`。這只收非敏感狀態與 Test environment 摘要；不要貼 API key、token、密碼、完整 `.env` 或含憑證的 log，也不要把它當成模型喚醒授權。

如果要準備第一次 Sandbox/Test 喚醒，請按 `複製喚醒前檢查`。它只確認環境、Hermes Sandbox/Test 員工、Sandbox/Test 專案與使用者確認；Office 最多預填 issue 草稿，不自動建立、不 Run now、不啟用排程。

如果未來真的跑完第一次 Sandbox/Test 喚醒，請按 `複製喚醒後覆盤`。它會用固定格式整理 Hermes 回覆、員工狀態、live runs、recovery issues 與下一步判斷；任何訊號不乾淨時先停下，不進正式專案。

如果新手照文件操作時卡住，可以按 `複製文件回饋`，用固定格式回報讀到哪份文件、哪一步卡住、哪些句子太工程化，以及安全提醒是否清楚。

如果要請新手協助試讀文件，請先按 `複製閱讀準備`。它會把第一次啟動、開源試用與 Hermes 前閱讀分成三組，讓回饋可以逐項對照。

如果試讀者不會程式，請按 `複製新手自評`。它只收集能不能照做、哪裡卡住、安全停手線是否清楚；不需要貼 API key、token、密碼或完整 `.env`，也不需要建立任務、Run now 或喚醒 Hermes。

若只想安排一次快速真人試讀，請按 `複製真人試讀任務`。它會產生 30 到 45 分鐘任務卡，限定只讀文件與畫面、不碰正式資料、不貼密鑰、不喚醒 Hermes，並用固定格式回報卡住位置。

## 文件地圖

新手可以依照目的打開文件：

- `docs/virtual-office-getting-started.zh-TW.md`：中文新手入門，適合第一次照流程操作。
- `docs/virtual-office-getting-started.en.md`：英文新手入門。
- `docs/virtual-office-quick-start.zh-TW.md`：中文最短啟動版，適合只想先打開預覽。
- `docs/virtual-office-quick-start.en.md`：英文最短啟動版。
- `docs/virtual-office-open-source-readme.zh-TW.md`：中文開源導覽。
- `docs/virtual-office-open-source-readme.en.md`：英文開源導覽。
- `docs/virtual-office-public-status.zh-TW.md`：可公開的進度摘要，排除本機路徑與私人流水帳。
- `docs/virtual-office-public-commit-scope.zh-TW.md`：中文公開提交範圍與本機檔案排除清單。
- `docs/virtual-office-public-commit-scope.en.md`：英文公開提交範圍與本機檔案排除清單。
- `docs/virtual-office-pr-submission-plan.zh-TW.md`：中文 PR 提交包草稿，整理檔案範圍、PR 文字與最後檢查。
- `docs/virtual-office-pr-submission-plan.en.md`：英文 PR 提交包草稿。
- `docs/virtual-office-pr-screenshot-evidence.zh-TW.md`：中文 PR 截圖證據包，說明如何產生與篩選本機截圖。
- `docs/virtual-office-pr-screenshot-evidence.en.md`：英文 PR screenshot evidence SOP。
- `docs/virtual-office-pr-final-review.zh-TW.md`：中文 PR 最終人工檢查，整理應提交、本機排除與人工看一眼項目。
- `docs/virtual-office-pr-final-review.en.md`：英文 PR final review。
- `docs/virtual-office-acceptance-checklist.zh-TW.md`：功能驗收與設計符合度紀錄。
- `docs/virtual-office-startup-sop.zh-TW.md`：開機後預覽或後端卡住時的復原流程。
- `docs/virtual-office-startup-sop.en.md`：英文開機與預覽復原流程。
- `docs/virtual-office-hermes-sop.zh-TW.md`：Hermes 本地模型安裝、環境測試與沙盒喚醒流程。
- `docs/virtual-office-routine-safety.zh-TW.md`：中文 Routine / schedule 排程安全說明。
- `docs/virtual-office-routine-safety.en.md`：英文 Routine / schedule safety notes.
- `docs/virtual-office-release-decision.zh-TW.md`：中文開源試用發布 Go / Pause SOP。
- `docs/virtual-office-release-decision.en.md`：英文 open-source trial release Go / Pause SOP。
- `docs/virtual-office-release-notes-draft.zh-TW.md`：中文開源發布備註草稿。
- `docs/virtual-office-release-notes-draft.en.md`：英文開源 release notes draft。
- `docs/virtual-office-feedback-triage.zh-TW.md`：中文開源回報分流 SOP。
- `docs/virtual-office-feedback-triage.en.md`：英文 open-source feedback triage SOP。
- `docs/virtual-office-maintainer-daily.zh-TW.md`：中文維護者日常檢查 SOP。
- `docs/virtual-office-maintainer-daily.en.md`：英文 maintainer daily SOP。
- `docs/virtual-office-feedback-to-work-items.zh-TW.md`：中文回報轉工作項目 SOP。
- `docs/virtual-office-feedback-to-work-items.en.md`：英文 feedback-to-work-items SOP。
- `docs/virtual-office-first-contribution.zh-TW.md`：中文第一次貢獻 SOP。
- `docs/virtual-office-first-contribution.en.md`：英文 first contribution SOP。
- `docs/virtual-office-pr-review.zh-TW.md`：中文 PR 審查 SOP。
- `docs/virtual-office-pr-review.en.md`：英文 PR review SOP。

## 建議預覽方式

```powershell
$env:PATH='C:\path\to\.tools;' + $env:PATH
$env:HEARTBEAT_SCHEDULER_ENABLED='false'
cd C:\path\to\paperclip
pnpm dev:once
```

然後打開：

```text
http://127.0.0.1:3100/AI/office
```

如果已經設定好 preview helper，也可以使用：

```powershell
pnpm run office:check
pnpm run office:start
pnpm run office:restart
```

如果想一次檢查 UI 型別、驗收同步、文件連結與預覽健康，可以使用：

```powershell
pnpm run office:verify
```

如果重開機後預覽仍卡住，打開 Office 新手操作檯，在 `預覽服務` 區塊按 `複製開機安全包`。這會把每日開工檢查、預覽求助文字、狀態報告覆盤模板與預覽故障決策表整理成一份可貼給 Codex 的安全包。

## 新手安裝前先確認

第一次開源試用前，請先確認：

- 必要項目：Node.js 與 pnpm 可用、Paperclip repo 已下載、前後端預覽可打開、heartbeat 先保持關閉。
- 可以先跳過：真正喚醒 Hermes、建立正式工作流、把 skills 同步到正式員工、停用或清理正式資料。
- 卡住時：先看開機預覽復原 SOP，確認 health 是否 OK，檢查是否有舊後端程序，再把畫面與錯誤貼回驗收紀錄。

開機預覽復原 SOP：

```text
docs/virtual-office-startup-sop.zh-TW.md
```

不會程式的新手也可以直接把這句貼給 Codex：

```text
請依照 docs/virtual-office-getting-started.zh-TW.md 與 docs/virtual-office-startup-sop.zh-TW.md 幫我檢查 Virtual Office，先只做健康檢查與安全說明，不要刪資料庫，不要建立或修改資料，不要喚醒 Hermes。
```
