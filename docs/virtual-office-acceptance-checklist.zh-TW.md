# Virtual Office 驗收檢查表

這份文件用來記錄 Virtual Office 每個功能是否符合原本設計。之後每次新增或修改功能，都同步更新這裡，避免做到後面才發現「看起來有了，但新手其實不會用」。

狀態說明：

- `已驗證`：已在本機瀏覽器確認可用。
- `部分完成`：已有初版，但還需要補強。
- `待開發`：尚未實作。
- `需人工驗收`：功能存在，但需要使用者實際試用判斷是否直覺。

同步檢查：

- UI 內的 `檢查清單` 是摘要版，適合在畫面中快速判斷目前完成度。
- 本文件是明細版，會保留更多開發過程中新增的驗收點。
- 每次新增或修改功能後，先執行 `pnpm run office:acceptance`，確認 UI 摘要與 Markdown 明細的統計差異是刻意保留，而不是漏記。
- Hermes / local model 的 Sandbox/Test 喚醒與 runtime capability key 真測已由 `AI-98530` 補上證據；下一次喚醒仍需新的 Sandbox/Test issue 與新的逐字一次性授權。

## 1. 新手是否能開始使用

| 檢查項目 | 驗收方式 | 目前狀態 | 開發紀錄 |
| --- | --- | --- | --- |
| AI-98235 post-cleanup diagnostic wake review | 已完成單次授權喚醒覆盤，清楚區分「後端已注入 runtime skills」與「Hermes CLI 尚未產生 exact key 回覆」 | 已驗證 | 2026-05-11 `AI-98235` 已 done，Hermes 已 paused/manual；run log 出現 `[paperclip] Hermes prompt routing: taskId=true taskBody=true runtimeSkills=true movedPromptTemplate=true authToken=false explicitApiKey=false`。該輪 exact key proof 未通過，但失敗原因已由後續橋接、prompt wording 與 final contract ordering 修正，並由 `AI-98530` 補上真測證據。 |
| Recovery issue recursion guard | Recovery issue 不會再被 recovery service 當成新的 stranded issue 無限延伸 | 已驗證 | 2026-05-11 已清理 `AI-98236` 到 `AI-98522` recovery chain；`server/src/services/recovery/service.ts` 排除 `stranded_issue_recovery`，targeted test `does not create recovery issues for stranded recovery issues` 通過。 |
| Hermes WSL bridge query-file routing | Hermes bridge 可安全處理含中文與 Markdown 反引號的 `chat -q` prompt，不再把長 prompt 直接塞進命令列 | 已驗證 | 2026-05-11 已新增 `scripts/hermes-wsl-query-helper.py` 並重新編譯 `scripts/hermes-wsl.exe`；只讀 smoke test `--version`、`chat --help`、含中文與三個反引號的 `chat -q ... --help` 皆通過。 |
| Hermes WSL bridge source-first 開源引用 | Windows/WSL bridge 以原始碼與建置腳本公開，不提交本機 `.exe` 產物，讓使用者自行編譯與設定 WSL 路徑 | 已驗證 | 2026-05-19 `scripts/hermes-wsl-bridge.cs`、`scripts/hermes-wsl-query-helper.py` 與 `scripts/hermes-wsl.cmd` 已改成使用 `HERMES_WSL_DISTRO` / `HERMES_WSL_PATH`，預設只呼叫 `hermes`；新增 `scripts/build-hermes-wsl-bridge.ps1` 與 `pnpm run hermes:wsl-bridge:build`；`scripts/hermes-wsl.exe` 已加入 `.gitignore`。 |
| 公開提交範圍文件 | 開源前有一份短版清單，分清楚可公開提交、本機排除、source-first bridge 與最後安全檢查 | 已驗證 | 2026-05-19 新增 `docs/virtual-office-public-commit-scope.zh-TW.md` 與英文版，並從 README、開源導覽與 release checklist 連入；自動驗收會檢查文件存在、source-first bridge、`scripts/hermes-wsl.exe` 不提交與 `pnpm run office:verify`。 |
| PR 提交包草稿 | 開源前有一份可直接整理 PR 的檔案範圍、PR body、驗證與風險草稿 | 已驗證 | 2026-05-19 新增 `docs/virtual-office-pr-submission-plan.zh-TW.md` 與英文版，並從 README、開源導覽、release checklist 與 public commit scope 連入；自動驗收會檢查建議 PR 標題、`pnpm run office:verify`、`scripts/hermes-wsl.exe` 排除與不喚醒 Hermes 的安全文字。 |
| PR 截圖證據包 | 開源 PR 前有本機截圖產生工具與截圖篩選 SOP，避免直接提交含私人資料的截圖 | 已驗證 | 2026-05-19 新增 `pnpm run office:pr-screenshots` 與 `scripts/capture-virtual-office-pr-screenshots.mjs`，截圖輸出到已忽略的 `.paperclip-local/virtual-office-pr-screenshots/`；工具會等待 Office 主內容 `A visual control room` / `New Agent` / `New Work`，避免只截到 app shell 或 loading skeleton；新增中英文 screenshot evidence SOP，並從 README、開源導覽、release checklist 與 PR submission plan 連入。 |
| PR 最終人工檢查 | 開 PR 前有最後一份人工清單，分出應提交、本機排除、截圖/英文/ROADMAP/PR 大小等人工看一眼項目 | 已驗證 | 2026-05-19 新增 `docs/virtual-office-pr-final-review.zh-TW.md` 與英文版，並從 README、開源導覽、release checklist、public commit scope 與 PR submission plan 連入；文件明列 `VIRTUAL_OFFICE_PROGRESS.md`、handoff、`.paperclip-local/`、`scripts/hermes-wsl.exe` 不進 PR，並保留 Hermes/Run now/schedule/heartbeat 停手線。 |
| 可以從側欄進入 Virtual Office | 側欄有 `Office` 入口，點擊後進入 `/AI/office` | 已驗證 | 已新增 Office route 與側欄入口 |
| 第一眼能理解這是虛擬辦公室 | 頁面上方有辦公室視覺、員工、專案、活動摘要 | 已驗證 | 2026-04-28 已加入桌椅、會議桌、植物、工作流走廊與 plan/build/review 標籤，並在瀏覽器確認四個房間與員工仍正常顯示 |
| 可接入辦公室參考圖 | 使用者提供的 2.5D 辦公室圖可放入 Office 頁作為底圖或未來生成圖參考 | 已驗證 | 已複製至 `ui/public/virtual-office/office-reference.png`，並接入 Office 視覺底層；本機確認圖片資源回傳 `200 image/png` |
| 不懂 Paperclip 的人也知道下一步 | `新手進度` 顯示完成數與下一步按鈕 | 已驗證 | 已顯示例如 `3 / 4 完成` |
| 可以展開每步驗收細節 | `新手進度` 可展開每一步要檢查的細項 | 已驗證 | 已加入展開/收起、進度條、狀態標籤與每步驗收項目；2026-04-28 已在瀏覽器確認 `顯示驗收`、`收起驗收` 與四步檢查項 |
| 可以記住已看過的驗收項目 | 標記某一步 `已讀` 後，重新整理頁面仍保留 | 已驗證 | 已加入本機已讀狀態；2026-04-28 已在瀏覽器確認 `1 / 4 已讀` 重新整理後仍保留 |
| 可以在 UI 查看整體檢查清單 | `檢查清單` 能打開目前功能驗收狀態摘要 | 已驗證 | 2026-04-28 已在瀏覽器確認五個分類、`已驗證`、`部分完成`、`待開發` 狀態與關閉流程 |
| 檢查清單有總覽統計 | 彈窗顯示已驗證比例與各狀態數量 | 已驗證 | 2026-05-05 已在後端復原頁安全操作加入後更新為 `58 / 67 項已驗證`、`87%`、各狀態數量與分類進度 |
| 檢查清單能提示下一步 | 彈窗集中列出尚未驗證的優先項目 | 已驗證 | 2026-04-29 已補上每個優先項目的 `建議驗收` 文字，提醒哪些項目目前只適合預覽、不要按最後提交 |
| 檢查清單可複製 Markdown | 彈窗提供 `複製 Markdown`，可複製驗收摘要、下一步與完整清單 | 已驗證 | 2026-04-29 已在瀏覽器確認 `複製 Markdown` 按鈕出現；功能只寫入本機剪貼簿，不會送出或修改 Paperclip 資料 |
| 下一步驗收指引可複製 | `複製 Markdown` 會把每個優先項目的建議驗收方式一起帶出 | 已驗證 | 2026-04-29 已加入 Markdown 輸出內容，方便明天照清單逐項 check |
| 今日驗收有摘要 | 檢查清單整理本日型別檢查、瀏覽器確認、安全邊界與文件同步 | 已驗證 | 2026-04-29 已新增 `今日驗收紀錄摘要`，讓之後可覆盤哪些項目已確認、哪些資料變更按鈕尚未觸碰 |
| 可用固定格式紀錄驗收 | 檢查清單顯示驗收紀錄模板，複製 Markdown 時也會帶出 | 已驗證 | 2026-04-29 已新增 `驗收紀錄模板`，包含日期、測試資料、操作步驟、預期結果、實際結果與結論 |
| 可依批次做端到端驗收 | 檢查清單列出沙盒、技能、員工、工作流、會議五個驗收批次 | 已驗證 | 2026-04-29 已新增 `端到端驗收批次計畫`，每批都有重點與注意事項，避免一次測太多會改資料的流程 |
| 每個批次有通過標準 | 每批顯示通過標準，複製 Markdown 時也會帶出 | 已驗證 | 2026-04-29 已補上 `通過標準`，讓技能同步、員工停用、工作流與會議覆盤知道什麼算完成 |
| 驗收失敗時知道怎麼停 | 每批顯示未通過時的暫停與紀錄方式，複製 Markdown 時也會帶出 | 已驗證 | 2026-04-29 已補上 `未通過時` 指引，提醒不要重複按建立、同步、停用或讓 agent 繼續討論 |
| 清理測試資料前有檢查 | 檢查清單提示清理前要確認測試標記、連結、正式任務與紀錄位置 | 已驗證 | 2026-04-29 已新增 `測試資料清理前檢查`，並明確標示不自動清理，避免誤刪正式資料 |
| 正式驗收前會先記錄快照 | 檢查清單提示在資料變更前記錄員工、技能、專案、會議與預覽服務狀態 | 已驗證 | 2026-04-29 已新增 `正式驗收前快照`，提醒先記錄再操作，Markdown 複製也會帶出 |
| 正式驗收前快照可單獨複製 | 檢查清單提供 `複製快照模板`，只複製正式驗收前需要填的欄位 | 已驗證 | 2026-04-29 已新增可單獨複製的快照模板，包含測試範圍、測試員工、測試專案、預計按下的資料變更按鈕與失敗暫停位置 |
| 可辨識會寫入資料的按鈕 | 檢查清單列出建立 starter skill、同步技能、保存、停用、建立工作流與建立會議任務 | 已驗證 | 2026-04-29 已新增 `資料變更按鈕索引`，每個動作都有會修改內容與安全預覽方式 |
| 可分流資料變更風險 | 檢查清單把動作分成低風險預覽、需要快照後再測、需要人工確認 | 已驗證 | 2026-04-29 已新增 `資料變更風險分流`，避免新手把可安全查看、可測試與需停下確認的動作混在一起 |
| 會改資料的操作有確認表 | 檢查清單列出建立 starter skill、同步技能、保存員工、停用員工、建立工作流與建立會議任務的操作前中後檢查點 | 已驗證 | 2026-04-29 已新增 `資料變更操作確認表`，讓正式端到端驗收時可逐項確認、截圖、暫停，不需要憑記憶操作 |
| 每批驗收有執行紀錄欄 | 檢查清單列出五個端到端驗收批次的結果欄、證據欄與暫停條件 | 已驗證 | 2026-04-29 已新增 `驗收批次執行紀錄`，讓正式驗收後能逐批留下證據與何時暫停的判斷 |
| 可判斷是否準備好端到端驗收 | 檢查清單用五個門檻整理快照、測試資料、批次順序、資料變更按鈕、失敗與清理規則 | 已驗證 | 2026-04-29 已新增 `端到端驗收準備度`，顯示 `5 / 5 已準備`，讓新手知道何時可以開始真正測資料變更 |
| 可判斷驗收後下一步 | 檢查清單列出可以繼續、先暫停、需要回復或需要人工介入的決策規則 | 已驗證 | 2026-04-29 已新增 `端到端驗收決策規則`，每條規則都有何時使用與下一步，Markdown 複製也會帶出 |
| 主畫面能看到驗收摘要 | 新手操作檯直接顯示建議批次、準備門檻、驗收批次與決策規則入口 | 已驗證 | 2026-04-29 已新增 `主畫面驗收摘要`，提醒先走沙盒與備份，並提供 `打開檢查清單` 入口 |
| 主畫面能判斷端到端驗收準備度 | 新手操作檯顯示測試員工、測試專案、starter skills、會議覆盤資料與下一批建議 | 已驗證 | 2026-05-06 已新增 `端到端驗收` 控制台，可複製沙盒訊號與下一批驗收建議；不會修改 Paperclip 資料 |
| 主畫面能提示工作流乾淨狀態 | 端到端驗收控制台列出 running/error 員工與 queued/running live runs，避免新手在自動喚醒風險下建立新工作流 | 已驗證 | 2026-05-07 控制台新增 `工作流乾淨狀態`；實際暫停 Eve 與 Sandbox PM 後，已補強為同時檢查員工狀態與舊工作佇列 |
| 主畫面可預填沙盒資料草稿 | 新手操作檯提供測試員工、測試工作流、測試會議與資料包複製入口 | 已驗證 | 2026-05-06 已新增 `沙盒資料包`，可預填 Sandbox PM、Virtual Office Sandbox 與 Sandbox Review；按最後建立前不會寫入資料 |
| 沙盒訊號不誤判正式資料 | 端到端驗收控制台只把名稱或職稱含 Test、Sandbox、測試、沙盒的員工/專案當沙盒 | 已驗證 | 2026-05-06 端到端驗收時發現 `Virtual Office MVP` 會被誤判成測試專案，已收緊判斷，不再只因 Virtual Office 字樣通過 |
| 沙盒員工與沙盒專案可被主畫面辨識 | 建立 `Sandbox PM` 與 `Virtual Office Sandbox` 後，端到端驗收控制台顯示測試員工與測試專案可驗收 | 已驗證 | 2026-05-06 已建立 Sandbox PM 與 Virtual Office Sandbox；瀏覽器確認控制台顯示兩者皆可驗收，下一批推進到測試員工管理 |
| 沙盒編輯不等於喚醒 | Sandbox/Test 中改描述、改派員工或安排工作流時，畫面與流程都應提醒這只是編輯，不是 Run now、排程或 agent 喚醒授權 | 已驗證 | 2026-05-17 由 `AI-98533` 測試補強：改派 Eve 與更新中文描述後，issue 仍是 backlog，active run 為 null，Eve 仍為 paused/manual；後續若要喚醒仍需新的逐字一次性授權。 |
| 沙盒安心狀態面板 | 主畫面直接顯示目前 active run 數、沙盒編輯不喚醒、喚醒需逐字一次性授權與 transient error 停手線 | 已驗證 | 2026-05-18 端到端驗收控制台新增 `沙盒安心狀態` 面板；當有 queued/running live run 時提供 `處理 active run` 入口，乾淨時明確顯示 `0 個` 與「編輯不會喚醒」。 |
| 沙盒成功範例 | 主畫面可複製一個完整 Sandbox/Test 成功案例，讓新手知道從建立任務、改派員工、一次性授權、模型留言到人工確認方向 OK 的順序 | 已驗證 | 2026-05-19 `AI-98533` 已由 Eve/Hermes local 在逐字一次性授權下產出「晨間財經新聞 AI 團隊」方案設計 comment；完成後 Eve 回到 paused/manual、issue 回到 backlog、active/live runs 為 0，使用者確認內容方向 OK。 |
| 非英文描述更新保護 | 更新 issue 描述時保留 UTF-8 中文內容，不把中文、標點或換行變成問號；同時確認 backlog 沙盒改派不會喚醒 agent | 已驗證 | 2026-05-17 新增 `issue-update-comment-wakeup-routes.test.ts` 回歸測試：以 `application/json; charset=utf-8` 送出 `晨間財經新聞 AI 團隊` 描述，確認 response 與 service patch 保留原文，且未新增 comment、未呼叫 heartbeat wakeup。 |
| 可以查看教學 | `使用教學` 能打開說明視窗 | 已驗證 | 已加入新手教學對話框 |
| 知道如何安全做端到端驗收 | 使用教學列出測試員工、測試專案、檢查清單與一次只測一種資料變更的方式 | 已驗證 | 2026-04-29 已新增 `端到端驗收沙盒`，讓之後真正按同步、建立、保存或停用前能先用測試資料 |
| 可分辨預覽與資料變更 | 使用教學列出哪些動作可安全預覽、哪些會修改本地資料 | 已驗證 | 2026-04-29 已在 `安全提醒` 中加入 `可安全預覽` 與 `會修改本地資料` 兩欄，避免新手誤按最後建立、同步、保存或停用 |

## 2. 員工與技能

| 檢查項目 | 驗收方式 | 目前狀態 | 開發紀錄 |
| --- | --- | --- | --- |
| 可以建立 AI 員工 | 從新手操作檯按 `建立員工`，開啟 Paperclip 既有建立員工視窗 | 已驗證 | 使用既有對話框，避免重做資料流程 |
| 可以替員工配置 skills | `安裝技能` 開啟技能安裝精靈，選員工後可勾選技能 | 已驗證 | 2026-05-09 UI、資料同步與只讀復查已驗證；2026-05-12 `AI-98530` 也完成 Hermes Sandbox/Test runtime capability key 真測。正式員工或正式專案仍需另行安全驗收。 |
| 技能同步端到端任務卡 | 檢查清單可複製技能同步 E2E 任務卡，驗證員工選擇、技能勾選、同步保存與重整後保留 | 已驗證 | 2026-05-09 新增 `複製技能同步 E2E`；只用 Sandbox/Test 員工驗證 UI 與資料同步，不建立 issue、不 Run now、不喚醒 Hermes，也不把結果當成 runtime loading 已完成 |
| 技能同步只讀復查 | 檢查清單可讀取 `Sandbox Skills Sync Test` 的 desired skills 並複製復查回報 | 已驗證 | 2026-05-09 新增 `複製技能同步復查`；只讀讀取 agent skills，確認 3 個 starter skills 保存狀態，不按同步、不建立 issue、不 Run now、不喚醒 Hermes/local model |
| 技能精靈完成判斷卡 | 檢查清單可複製技能精靈完成判斷，區分 UI/資料同步已通過與 runtime skill loading 尚待 Hermes/local adapter | 已驗證 | 2026-05-09 新增 `複製技能完成判斷`；避免把 desired skills 保存誤判成模型執行時已真的載入 skills |
| 沙盒員工技能配置可持久化 | 將 starter skills 同步到沙盒員工後，重新讀取 agent skills 仍保留 desired skills | 已驗證 | 2026-05-07 `Sandbox Skills Sync Test` 已同步 `會議紀錄與覆盤`、`需求分析`、`測試檢查`，重新讀取後包含 Paperclip 內建 4 個 skills 與 3 個 starter skills，共 7 個 desired skills |
| 技能精靈有新手步驟提示 | 精靈顯示選員工、選推薦包、補 starter skill、同步技能四步 | 已驗證 | 2026-04-28 已在瀏覽器確認四步提示、目前選取數量與「同步才會寫入」提醒 |
| 可以看出 starter skills 是否已準備 | 技能精靈顯示三個 starter skills 的已準備數、缺少數與下一步操作 | 已驗證 | 2026-04-28 已在瀏覽器確認 `0 / 3 已準備`、`還缺 3 個，請先預覽再建立。`、`勾選已存在 starter skills` 與每個範本的預覽/建立提示；本次沒有按建立或同步 |
| 外部角色模板已排程 | 技能精靈顯示 agency-agents 可作為未來角色與 skills 模板來源 | 已驗證 | 2026-04-28 已新增 `角色模板來源` 區，先列出 Project Manager、Frontend Developer、Backend Architect、AI Engineer、Code Reviewer、Technical Writer；目前只做預選 skills 與排程提示，尚未直接匯入外部 repo |
| 可以查看角色模板細節 | 按 `查看角色` 後可看到建議職稱、能力描述、starter skills 與適合任務 | 已驗證 | 2026-04-28 已新增角色模板詳情視窗，讓使用者先理解角色用途；本次沒有建立員工或同步 skills |
| 角色模板可預填建立頁 | 按 `用此角色建立草稿` 後進入建立員工頁，預填姓名、職稱、角色與 prompt 草稿 | 已驗證 | 2026-04-28 已讓建立員工頁支援 `name`、`title`、`role`、`promptTemplate` 網址參數；角色模板只開草稿頁，不會送出建立 |
| 建立頁保留角色草稿上下文 | 從角色模板進入建立頁後，頁面仍顯示來源角色與建議 starter skills | 已驗證 | 2026-04-28 已在建立員工頁加入 `Virtual Office 角色草稿` 提示，保留模板來源與建議 skills；仍需使用者自行按 Create agent |
| 個人公司角色模板已擴充 | 角色模板來源區提供 10 種角色，涵蓋管理、工程、品質、文件、研究、資料、營運與風險 | 已驗證 | 2026-04-29 已新增 Research Analyst、Data Steward、Operations Coordinator、Security Reviewer；仍只做預覽與建立草稿，不會自動建立員工 |
| 可以從 Office 管理員工 | 右側員工清單與新手操作檯都能打開管理視窗 | 已驗證 | 2026-04-28 已在瀏覽器確認 `Employee Setup` 有 `管理 Alice/Bob/Carol/Eve` 按鈕，並能打開 `管理員工` 視窗；2026-04-29 已在瀏覽器確認新手操作檯 `管理員工` 按鈕能開啟同一個管理視窗，且視窗內可切換不同員工 |
| 可以快速套用員工職責範本 | 管理視窗提供 PM、工程、測試、設計四個範本，套用後填入職稱與能力備註 | 已驗證 | 2026-04-29 已在瀏覽器確認 `PM / 主管`、`工程`、`測試 / 覆盤`、`產品設計` 按鈕存在；套用 `產品設計` 後欄位更新，本次沒有保存 |
| 停用前可看影響範圍 | 管理視窗顯示該員工的進行中任務與主管專案 | 已驗證 | 2026-04-29 已在瀏覽器確認 Alice 顯示 `1 個進行中任務 · 0 個主管專案`，並列出 `AI-326 · 開發階段：串接 Paperclip agents/projects/issues`；本次沒有停用 |
| 未保存變更有明確提示 | 管理視窗未修改時保存不可按，套用範本或編輯後顯示未保存提示 | 已驗證 | 2026-04-29 已在瀏覽器確認一開始顯示 `目前沒有未保存變更。` 且 `保存變更` 不可按；套用 `產品設計` 後顯示未保存提示並啟用保存。本次沒有保存 |
| 停用前有交接建議 | 管理視窗依角色、同區域與目前工作量推薦可交接員工 | 已驗證 | 2026-04-29 已在瀏覽器確認 `交接建議` 會列出候選人與 `件進行中` 工作量，並提示不會自動改派任務或更動專案主管。本次沒有保存或停用 |
| 可以產生交接會議草稿 | 管理視窗可展開停用前交接議程，提醒先確認任務、主管、紀錄與下一步 | 已驗證 | 2026-04-29 已在瀏覽器確認 `產生交接會議草稿` 會展開 `交接會議議程草稿`，並包含停用前確認事項；本次沒有建立會議任務、保存或停用 |
| 有影響時必須確認交接 | 員工仍有進行中任務或主管專案時，停用前需額外勾選交接確認 | 已驗證 | 2026-04-29 已在瀏覽器確認 Alice 有進行中任務時會顯示交接確認框；只勾一般停用確認後，`停用員工` 仍不可按。本次沒有停用 |
| 未保存變更時不可停用 | 管理視窗有未保存變更時，停用按鈕不可按並提示先保存或取消 | 已驗證 | 2026-04-29 已在瀏覽器確認套用 `產品設計` 範本後會顯示未保存停用提示，`停用員工` 不可按、`保存變更` 可按。本次沒有保存或停用 |
| 管理視窗操作列可在預覽瀏覽器點擊 | 管理員工視窗內容可捲動，底部取消與保存操作列固定在視窗內 | 已驗證 | 2026-05-06 已將管理視窗改為 `max-height` 內部捲動與固定底部操作列，瀏覽器可直接點擊 `保存變更`，不再被彈窗下半部座標限制卡住 |
| 沙盒員工職稱可保存並持久化 | 只用測試員工修改職稱，保存後重新整理仍顯示新職稱 | 已驗證 | 2026-05-06 已將 `Sandbox PM` 職稱從 `Virtual Office Sandbox Lead PM` 用 UI 改為 `Virtual Office Sandbox UI Lead PM`，重新整理 Office 後仍可看到新職稱；本次沒有停用員工 |
| 沙盒員工可安全停用 | 只用沒有正式任務、不是專案主管的測試員工驗收停用；停用後主畫面不再顯示，但歷史 agent 記錄仍保留 | 已驗證 | 2026-05-06 建立 `Sandbox Termination Test`，確認 `停用員工` 在未勾選前不可按，勾選確認後用 UI 停用；重新檢查後主畫面不再顯示，API 仍可查到 agent 且狀態為 `terminated` |
| 有主管專案時會要求交接確認 | 測試員工仍是專案主管或有任務時，管理視窗顯示交接確認；只勾一般停用確認仍不可停用 | 已驗證 | 2026-05-07 使用 `Sandbox UI Final Handoff Test` 與 `Virtual Office UI Final Handoff Sandbox` 驗收，管理視窗顯示主管專案、交接建議與交接確認框；UI 勾選兩個確認後成功停用 |
| 可以改名、改職稱與安全停用 | 管理視窗可修改名稱、職稱、能力備註；停用前必須勾確認 | 已驗證 | 2026-05-07 已完成沙盒職稱保存、無影響沙盒停用、交接確認門檻與完整交接停用 UI 最終點擊；API 確認 `Sandbox UI Final Handoff Test` 狀態為 `terminated` |
| 新手知道 skill 適合誰 | 技能列表顯示適合 PM、工程、測試或其它角色的提示 | 已驗證 | 已加入簡化說明 |
| 可以建立 starter skills | 技能精靈提供會議、需求、測試三個 starter skill | 已驗證 | 2026-05-07 三個 starter skills 已存在於公司技能庫，並可同步給沙盒員工；`會議紀錄與覆盤`、`需求分析`、`測試檢查` 各維持一筆 |
| starter skill 不會因中文名稱互相覆蓋 | 建立 starter skill 時使用穩定英文 slug，不讓中文名稱都變成 `skill` | 已驗證 | 2026-05-06 端到端建立時發現三個中文 starter skills 會共用 `company/.../skill` 而互相覆蓋；已改為送出 meeting-notes、requirements-analysis、quality-check |
| 建立前可預覽 skill 內容 | 按 `預覽` 後能看到用途與 markdown 指令 | 已驗證 | 已在瀏覽器確認預覽視窗 |
| 不會重複建立同名 starter skill | 已存在時改為勾選既有 skill | 已驗證 | 2026-05-07 重新檢查公司技能庫後，starter skills 維持 3 筆；第二位沙盒員工同步後只增加 attached count，沒有新增同名技能 |

## 3. 專案與工作流

| 檢查項目 | 驗收方式 | 目前狀態 | 開發紀錄 |
| --- | --- | --- | --- |
| 可以一鍵建立專案工作流 | `建立工作流` 表單可建立專案與五個任務階段 | 已驗證 | 2026-05-07 在乾淨狀態用 UI 建立 `Virtual Office Sandbox Workflow Clean E2E`，API 確認建立 1 個沙盒專案與 5 個階段任務，沒有 queued/running live runs 殘留 |
| 建立前可預覽工作流 | 建立前先顯示五階段、專案主管、階段負責人與依賴關係 | 已驗證 | 2026-04-29 已在瀏覽器確認 `建立前預覽`、`專案主管`、`起點`、`等待上一階段` 與負責人資訊；本次沒有按建立 |
| 工作流表單操作列可在預覽瀏覽器點擊 | 建立工作流視窗內容可捲動，底部取消與建立操作列固定在視窗內 | 已驗證 | 2026-05-07 乾淨工作流驗收時發現建立按鈕落到視窗外；已改為 `max-height` 內部捲動與固定底部操作列，瀏覽器成功點擊 `建立工作流` |
| 建立工作流前會提示自動喚醒風險 | 若有 `running` 或 `error` 員工，建立前要求確認可能產生 recovery 任務 | 已驗證 | 2026-05-07 沙盒工作流端到端測試時發現執行中/錯誤 agent 會讓測試任務產生 recovery 干擾；已在建立工作流視窗加入風險提示與確認勾選，並在瀏覽器確認未勾選前 `建立工作流` 不可按 |
| 可處理工作流乾淨驗收門檻 | 主畫面提供處理入口，讓使用者確認後暫停 running/error 員工，再做乾淨工作流驗收 | 已驗證 | 2026-05-07 已新增 `處理乾淨驗收` 對話框，瀏覽器確認可開啟，會列出風險員工，且未勾確認框前 `暫停選取員工` 不可按；後續已實際暫停 Eve 與 Sandbox PM，並確認主畫面回到 `可驗收` |
| 乾淨驗收會排除舊佇列 | 乾淨工作流前要確認不只沒有 running/error 員工，也沒有 queued/running live runs | 已驗證 | 2026-05-07 實際暫停 Eve 與 Sandbox PM 時發現 Eve 的 recovery run 會在暫停後留下 queued/running runs；已手動取消殘留 run，並補強主畫面乾淨狀態會一起檢查 live runs |
| 可處理舊工作殘留 | 若只剩 queued/running live runs，主畫面仍能提供處理入口，讓使用者確認後取消舊 run | 已驗證 | 2026-05-07 已把 `處理乾淨驗收` 對話框擴充為同時列出風險員工與舊工作；按鈕在只剩舊工作時也會出現，且未勾確認前不能處理 |
| 平行模式建立前可預覽 | 切換 `平行單位協作` 後，預覽顯示共同輸入、平行單位、統整輸出與彙整規則 | 已驗證 | 2026-04-29 已在瀏覽器用 `工作流型態` 下拉切到平行模式，確認 `共同輸入`、`平行單位`、`統整輸出`、`需求後可平行`、`彙整平行成果` 與 `平行單位協作規則` 都會顯示；本次沒有按建立 |
| 可以指定專案主管 | 工作流表單可選主管或自動選擇 | 已驗證 | UI 已顯示 |
| 可以指定每階段負責人 | 表單列出需求、設計、實作、測試、覆盤負責人 | 已驗證 | UI 已顯示 |
| 支援上下游順序 | 工作流型態可選 `上下游順序`，建立時寫入 blockers | 已驗證 | 2026-05-07 `Virtual Office Sandbox Workflow Clean E2E` 已驗證需求 → 設計 → 實作 → 測試 → 覆盤的 blockers 鏈正確保存 |
| 沙盒上下游鏈可保存 | 五個人工任務可保存成需求 → 設計 → 實作 → 測試 → 覆盤的 blockers 鏈 | 已驗證 | 2026-05-07 API 驗證 `Virtual Office Sandbox Workflow E2E` 的五個人工任務已保存為 `需求整理` → `方案設計` → `實作處理` → `測試檢查` → `覆盤紀錄`；需求整理仍受 recovery 子任務影響，所以整個一鍵建立仍保留部分完成 |
| 支援平行單位協作 | 工作流型態可選 `平行單位協作`，建立時寫入 blockers | 已驗證 | 2026-05-07 用 UI 建立 `Virtual Office Sandbox Parallel Workflow E2E`；API 確認方案設計、實作處理、測試檢查共同依賴需求整理，覆盤紀錄彙整平行階段 blockers |
| 專案頁能看工作流地圖 | Project Issues 上方顯示 `2.5D 工作流地圖` | 已驗證 | 已在瀏覽器確認 |
| 工作流地圖能看出卡點 | 地圖顯示完成數與等待上游數 | 已驗證 | 已顯示例如 `2 / 5 完成`、`2 個等待上游` |
| 工作流地圖能看出平行/上下游 | 以箭頭或分組明確標出依賴方向 | 已驗證 | 已在瀏覽器確認流程方向圖例、階段箭頭、平行區數量與任務卡上游提示 |
| 工作流地圖會隱藏 recovery 干擾 | Project Issues 的 2.5D 地圖不把系統復原任務混入正式流程卡片或正式上游 | 已驗證 | 2026-05-07 沙盒工作流測到大量 recovery issues；已讓地圖隱藏系統復原任務與 recovery 上游，並顯示隱藏提示，避免新手誤判工作流 |
| 工作流地圖分類有測試 | 標題優先分類與 recovery 任務辨識有自動測試保護 | 已驗證 | 2026-05-07 已新增 `src/lib/project-workflow-map.test.ts`，確認 `測試檢查` 不會因描述含「需求」被放錯欄，且 `Recover stalled issue` / `stranded_issue_recovery` 會被辨識為系統復原任務 |
| Office 與專案頁共用復原判斷 | Office 主頁和 Project Issues 使用同一份系統復原任務判斷規則 | 已驗證 | 2026-05-07 已將 Office 主頁的 recovery 過濾改用 `src/lib/project-workflow-map.ts`，避免兩個頁面未來各自誤判；UI 摘要檢查清單也同步列入 |
| Office 主頁有工作流圖例 | Project Workflows 區說明上下游方向、平行處理與等待上游 | 已驗證 | 2026-04-29 已新增 Office 主頁圖例，讓新手不用先進專案頁也能理解工作流卡片怎麼看 |

| Routine 排程安全面板 | Office 只讀顯示 routines、schedule triggers、active routine issues 與 Sandbox 排程狀態，並連到既有 Routines 頁 | 已驗證 | 2026-05-08 新增 `Routine / schedule 安全面板`，只做狀態判讀與導向，不直接啟用 cron、不手動 run routine、不喚醒 Hermes |
| Routine 草稿預填 | Office 可預填 Sandbox routine 草稿，Routines 建立視窗會顯示安全提醒 | 已驗證 | 2026-05-08 `預填 routine 草稿` 只帶入標題與描述，建立視窗提示不要啟用 schedule trigger、不要指派 Hermes；使用者仍需手動按 Create routine |
| Routine trigger 安全門 | Virtual Office routine 詳情頁新增 trigger 前必須先勾選 Sandbox/Test 安全確認 | 已驗證 | 2026-05-08 `RoutineDetail` 會辨識 Virtual Office / Sandbox routine，顯示安全門；Add trigger 在未勾選前保持停用，避免新手誤開排程 |
| Routine 手動執行安全門 | Virtual Office routine 按 Run now 前必須先勾選 Sandbox/Test 安全確認 | 已驗證 | 2026-05-08 共用 Run routine 對話框新增安全確認；Routines 清單與 RoutineDetail 兩個入口都會要求確認後才能手動執行 |
| Routine 啟用前檢查表 | Office 可複製 routine/schedule 啟用前 Markdown 檢查表 | 已驗證 | 2026-05-08 排程安全面板新增 `複製排程檢查表`，涵蓋建立草稿、新增 trigger、Run now 與完成後覆盤 |
| Routine 新手安全文件 | 開源新手可閱讀 routine/schedule 的可做、不可自動做、trigger 前與 Run now 前檢查 | 已驗證 | 2026-05-08 新增 `docs/virtual-office-routine-safety.zh-TW.md`，說明 Office 不會自動建立 routine、啟用 trigger、Run now、指派 Hermes 或開啟 heartbeat |
| Routine 安全三步驟 | Routine 安全面板直接顯示先草稿、再安全門、最後覆盤 | 已驗證 | 2026-05-08 Office 面板新增三張短步驟卡，提醒新手先預填 Sandbox/Test 草稿，再確認 trigger / Run now 安全門，最後檢查 runs、active issues 與 recovery issues |
| Routine 英文安全文件 | 英文開源讀者可閱讀 routine/schedule safety notes | 已驗證 | 2026-05-08 新增 `docs/virtual-office-routine-safety.en.md`，英文開源導覽與 Office 教學文件地圖都會指向英文版 |
| 入門文件排程安全 | 中英文 getting started 都提醒 routine/schedule 安全順序與安全文件入口 | 已驗證 | 2026-05-08 入門文件新增 Routine / schedule safety 章節，列出先草稿、再安全門、最後覆盤，並分別連到中英文 safety notes |
| 開源導覽文件地圖 | 中英文開源導覽都列出新手、驗收、預覽復原、Hermes 與 Routine safety 文件用途 | 已驗證 | 2026-05-08 開源導覽新增 Documentation Map，讓新手不用從檔名猜每份文件用途 |
| 中文入門文件地圖 | 中文 getting started 列出新手、開源導覽、驗收、預覽復原、Hermes 與 Routine safety 文件用途 | 已驗證 | 2026-05-08 中文入門文件新增文件地圖與 preview helper 指令，和英文入門文件對齊 |
| 每日開工前安全檢查 | 中英文入門文件提醒每天先跑 office:check，後端前端都 OK 才碰資料變更 | 已驗證 | 2026-05-08 入門文件新增 Daily Start Check / 每日開工前安全檢查；英文開源導覽也補上 `pnpm run office:check` |
| UI 有每日開工前安全檢查 | 使用教學提醒每天先跑 office:check，Backend OK / Frontend OK 後才碰資料變更 | 已驗證 | 2026-05-08 Office 使用教學新增 `每日開工前安全檢查`，把重開機後先檢查預覽服務、heartbeat、running/error 員工與 recovery issues 的流程放進畫面 |
| UI 可複製每日開工檢查 | 使用教學可一鍵複製每日開工前安全檢查文字 | 已驗證 | 2026-05-08 Office 使用教學新增 `複製開工檢查`，提醒 office:check 沒通過前不要建立、同步、保存、停用、Run now 或喚醒 Hermes |
| UI 可複製預覽求助文字 | 新手操作檯可一鍵複製預覽卡住時的安全求助文字 | 已驗證 | 2026-05-08 預覽服務區塊新增 `複製預覽求助`，要求先看 `.virtual-office-preview-status.json` 與 `office:check`，不刪資料庫、不手動刪 lock file、不喚醒 Hermes |
| UI 有狀態報告欄位翻譯 | 新手操作檯會解釋 `.virtual-office-preview-status.json` 的主要欄位 | 已驗證 | 2026-05-08 預覽服務區塊新增 `狀態報告欄位翻譯`，說明 `backendOk`、`frontendOk`、`embeddedPostgresLockFile.exists`、`portOwnership` 與 `nextAction` 對應的安全下一步 |
| UI 可複製狀態報告覆盤模板 | 新手操作檯可一鍵複製預覽狀態報告覆盤格式 | 已驗證 | 2026-05-08 預覽服務區塊新增 `複製狀態模板`，保留 `generatedAt`、`backendOk`、`frontendOk`、`heartbeatSchedulerEnabled`、`embeddedPostgresLockFile.exists`、`portOwnership` 與 `nextAction` 欄位 |
| UI 有預覽故障決策表 | 新手操作檯把預覽狀態轉成先做與先不要做 | 已驗證 | 2026-05-08 預覽服務區塊新增 `預覽故障決策表`，說明 `backendOk = false`、`backendOk = true / frontendOk = false`、lock file 與舊程序佔用時的安全下一步；前端 blocked 但後端 OK 時只重啟前端預覽，不刪資料庫、不喚醒 Hermes |
| UI 可複製預覽故障決策表 | 新手操作檯可一鍵複製預覽故障決策表 | 已驗證 | 2026-05-08 預覽服務區塊新增 `複製決策表`，讓卡住時可把 `backendOk = false`、`frontendOk = false`、lock file 與 port 佔用的安全下一步貼給 Codex |
| UI 可複製開機安全包 | 新手操作檯可一鍵複製每日開工、預覽求助、狀態模板與決策表 | 已驗證 | 2026-05-08 預覽服務區塊新增 `複製開機安全包`，把每日開工檢查、預覽求助文字、狀態報告覆盤模板與預覽故障決策表整理成一份可貼給 Codex 的安全包 |
| 文件說明開機安全包 | 開機 SOP 與入門文件說明何時使用 `複製開機安全包` | 已驗證 | 2026-05-08 `docs/virtual-office-startup-sop.zh-TW.md` 新增 `開機安全包` 段落；入門文件的每日開工檢查也提醒卡住時可複製整包貼給 Codex |
| 中文開源導覽說明開機安全包 | 中文開源導覽說明 `複製開機安全包` 的用途 | 已驗證 | 2026-05-08 中文開源導覽的建議預覽方式補上 `複製開機安全包`，讓中文開源讀者也知道重開機卡住時可複製整包貼給 Codex |
| 英文文件說明開機安全包 | 英文入門與英文開源導覽說明 `Copy startup safety bundle` 的用途 | 已驗證 | 2026-05-08 英文入門 Daily Start Check 與英文開源 Preview Command 補上 `Copy startup safety bundle`，讓英文讀者知道重開機後可把安全包貼給 Codex |
| 預覽穩定主線已串起 | UI、文件、狀態報告與決策表共同支援重開機後復原 | 已驗證 | 2026-05-08 已把 `複製開機安全包`、`.virtual-office-preview-status.json`、預覽故障決策表、中英文文件說明與 `office:check` 串成同一條預覽/後端穩定主線 |
| 前端 blocked 但後端 OK 有 SOP | 文件說明 Backend OK / Frontend blocked 時只重啟預覽服務，不刪資料庫、不喚醒 Hermes | 已驗證 | 2026-05-08 `office:verify` 曾出現 Backend OK / Frontend blocked；已照 helper 重啟後恢復，並補進開機 SOP 與中英文入門文件 |
| 一鍵完整驗證指令 | 提供單一指令檢查 UI 型別、驗收同步、文件與預覽健康 | 已驗證 | 2026-05-08 新增 `pnpm run office:verify`，串起 `@paperclipai/ui typecheck`、`office:acceptance` 與 `office:check`，並補進中英文入門與開機 SOP |
| 開源導覽說明一鍵驗證 | 中英文開源導覽都說明 `pnpm run office:verify` | 已驗證 | 2026-05-08 中英文開源導覽的預覽方式補上 `office:verify`，讓開源讀者可一次跑 UI 型別、驗收同步、文件與預覽健康 |
| UI 顯示完整驗證指令 | 新手操作檯預覽服務區塊顯示 `pnpm run office:verify` | 已驗證 | 2026-05-08 Office 預覽服務區塊補上 `pnpm run office:verify`，讓新手從畫面就能找到完整驗證入口 |
| 接近完成總結 | 檢查清單可顯示並複製目前完成度、剩餘 gate 與下一個安全動作 | 已驗證 | 2026-05-09 新增 `接近完成總結` 與 `複製完成總結`；提醒目前主要剩 skills runtime 載入、文件真人試讀與 Hermes 沙盒喚醒，並列出不可越線動作 |
| 理想版交付判斷卡 | 檢查清單可把目前狀態分成可交付、仍需證據與不可越線三類，供開源前最後 check 使用 | 已驗證 | 2026-05-10 新增 `複製交付判斷`；可開源試用不等於 Hermes 真喚醒完成，skills runtime、文件真人試讀與 Hermes 沙盒喚醒仍需證據 |
| 完成前剩餘路線 | 檢查清單明列技能 runtime、文件人工閱讀、Hermes 沙盒喚醒與開源前穩定性 gate 的最新狀態 | 已驗證 | 2026-05-12 已把 `AI-98530` Sandbox/Test runtime capability key 真測結果同步進剩餘路線；目前主要剩文件真人試讀、多次重開機與長時間穩定性驗收。 |
| 98% 剩餘缺口交接 | 檢查清單會列出所有部分完成、待開發與需人工驗收項目，並提供可複製的下一步交接 | 已驗證 | 2026-05-12 缺口交接已更新為：skills runtime 與 Hermes 沙盒喚醒已有 AI-98530 證據；正式員工仍需另行授權；文件真人試讀與開源前穩定性仍需收尾。 |
| 可單獨複製剩餘路線 | 檢查清單可只複製完成前剩餘 gate，不必複製整份驗收清單 | 已驗證 | 2026-05-08 新增 `複製剩餘路線`，共用完整 Markdown 的剩餘路線產生器，方便貼給 Codex 或測試者逐項確認 |
| 完成前 Gate 交接包 | 檢查清單可複製最後 gate 交接包，列出完成條件、阻塞原因與不可越線動作 | 已驗證 | 2026-05-09 新增 `複製 Gate 交接`；明確提醒不要把 skills UI 同步當成 runtime 已驗證、不要把文件工具當成人工閱讀已完成、不要安裝或喚醒 Hermes |
| 剩餘 Gate 決策板 | 檢查清單把最後 gate 分成今天可做、先暫緩與授權後才做 | 已驗證 | 2026-05-10 新增 `剩餘 Gate 決策板` 與 `複製 Gate 決策`，把 office:verify、文件試讀、skills 復查、Hermes 安裝與 Run now 停手線整理成每日判斷 |
| 入門與開源文件說明剩餘路線 | 中英文入門與開源導覽都說明可用 `複製剩餘路線` 交接最後 gate | 已驗證 | 2026-05-08 四份新手/開源文件補上剩餘路線說明，讓非工程使用者可只貼最後三項 gate，不必複製整份驗收清單 |
| Runtime skill loading 驗收模板 | 檢查清單可複製 runtime skill loading 驗收格式，並可引用 `AI-98530` 的 Sandbox/Test exact key proof | 已驗證 | 2026-05-12 模板已更新為可記錄 Paperclip runtime capability keys 是否逐字列出；`AI-98530` 已證明 Hermes Sandbox/Test 回覆能列出 7 個 exact keys。 |
| 入門與開源文件說明技能載入驗收 | 中英文入門與開源導覽都說明可用 `複製技能載入驗收` 驗證 runtime skill loading | 已驗證 | 2026-05-08 四份新手/開源文件補上 runtime skill loading 驗收入口，提醒只用 Sandbox/Test issue 並記錄 adapter 支援與 agent 回覆證據 |
| Hermes runtime skill loading 準備度 | Hermes 區塊只讀顯示 adapter skills、starter skills 同步、Sandbox/Test 與下一步驗收狀態 | 已驗證 | 2026-05-08 新增 `技能載入驗收準備度` 面板，條件未齊前只看狀態與同步 skills，不建立 issue、不喚醒 Hermes 或其它本地模型 |
| 技能同步驗收交接 | Hermes 區塊可複製技能同步驗收交接模板，區分 desired skills 已保存與 runtime 是否真的載入 | 已驗證 | 2026-05-09 新增 `複製技能交接`；模板只整理 starter skills、Sandbox 員工、Sandbox 專案與 runtime readiness，不建立 issue、不 Run now、不喚醒 Hermes |
| Runtime skill loading 模擬自檢 | Hermes 區塊可在不建立 issue、不喚醒模型的前提下，整理 starter skills runtime payload 與缺口 | 已驗證 | 2026-05-09 新增 `複製 dry-run`；只讀整理 adapter、Hermes Sandbox 員工、Sandbox/Test 專案與 desired skills payload，仍不等於模型已實際載入技能 |
| Hermes runtime skills 注入路徑 | hermes_local 真正 execute 時會把 desired Paperclip runtime skills 帶入 Hermes 可讀的任務內容 | 已驗證 | 2026-05-11 後端 `hermes_local` wrapper 會把 runtime skills、auth guard 與自訂 promptTemplate 移入 `taskBody`，並在 heartbeat 只提供 `context.paperclipIssue` / `context.paperclipTaskMarkdown` 時補回 Hermes 會讀取的 `taskId`、`taskTitle`、`taskBody`；`adapter-registry.test.ts` 已覆蓋 taskBody、自訂 promptTemplate 與 context-only issue 三種情境。這證明 Paperclip 會交付技能內容，但模型是否實際照用仍需下一張 Sandbox/Test issue 回覆證據。 |
| Runtime skill loading 缺口修補順序 | Hermes 區塊會依 dry-run 缺口提示先建 Sandbox 草稿、同步 starter skills，再重跑 dry-run | 已驗證 | 2026-05-09 新增 `缺口修補順序` 與 `複製修補順序`；入口只導向草稿與手動同步，不會自動建立正式 issue、Run now、排程或喚醒 Hermes |
| 文件說明技能載入準備度 | 中英文入門、開源導覽與 Hermes SOP 都說明 `技能載入驗收準備度` 是只讀檢查 | 已驗證 | 2026-05-08 文件補上 adapter skills、starter skills、Sandbox/Test 與下一步四格，提醒條件未齊前不要建立 issue 或喚醒模型 |
| 文件人工閱讀回饋模板 | 檢查清單可複製文件閱讀回饋格式，協助新手回報卡住位置與安全提醒是否清楚 | 已驗證 | 2026-05-08 新增 `複製文件回饋`，涵蓋閱讀文件、目標、卡住位置、太工程化語句、安全提醒與結論 |
| 文件人工閱讀準備度 | 檢查清單列出第一次啟動、開源試用與 Hermes 前的閱讀文件、檢查問題與複製入口 | 已驗證 | 2026-05-08 新增 `文件人工閱讀準備` 區塊與 `複製閱讀準備`，把必讀、建議讀與 Hermes 前再讀拆成三組閱讀任務，讓非工程新手可逐項回報 |
| 新手文件自評表 | 檢查清單可複製非工程新手文件自評表，回報能否照做、哪裡卡住與安全停手線是否清楚 | 已驗證 | 2026-05-09 新增 `複製新手自評`；自評表聚焦健康檢查、卡住原句、是否知道不要刪資料庫、不要貼 API key、不要喚醒 Hermes |
| 中文文件完成判斷卡 | 檢查清單可複製中文文件完成判斷，區分文件工具已準備與仍需非工程新手實際試讀 | 已驗證 | 2026-05-10 新增 `複製中文完成判斷`；沒有非工程新手實際試讀前，不把中文文件 gate 視為完成 |
| 真人試讀任務卡 | 檢查清單可複製給試讀者的任務卡，限定閱讀範圍、時間、安全邊界與回報格式 | 已驗證 | 2026-05-09 新增 `複製真人試讀任務`，可交給朋友或開源試用者 30-45 分鐘試讀；只看文件與畫面，不建立任務、不貼密鑰、不喚醒 Hermes |
| 開源試讀邀請包 | 檢查清單可複製給朋友或 GitHub 讀者的試讀邀請，說明目標、範圍、安全界線與回覆方式 | 已驗證 | 2026-05-09 新增 `複製開源試讀邀請`，用白話邀請讀者試讀文件與畫面，回報是否看懂第一步、安全界線與卡住位置 |
| 開源試用回報包 | 檢查清單可複製給開源試用者的回報格式，收集系統、預覽狀態、卡住點與安全界線，不要求貼密鑰、完整 log 或私密路徑 | 已驗證 | 2026-05-10 新增 `複製試用回報`；試用者可回報 OS、Backend/Frontend 狀態、卡住步驟與錯誤摘要，但不得貼 API key、完整 `.env`、完整 log 或私密路徑 |
| 開源 issue 回報模板 | 檢查清單可複製 GitHub issue 友善回報格式，分流啟動卡住、畫面文字、文件、Hermes 前置與安全疑慮 | 已驗證 | 2026-05-10 新增 `複製 issue 回報`；只收短錯誤摘要與環境狀態，不收 API key、完整 `.env`、完整 log、私密路徑或正式資料 |
| GitHub issue template | `.github/ISSUE_TEMPLATE/virtual-office.yml` 存在，並用欄位化 issue form 收集 Virtual Office 試用回報 | 已驗證 | 2026-05-10 新增 GitHub issue form，包含啟動、UI、文件、Hermes readiness、Routine 安全分類與敏感資訊停手確認 |
| GitHub issue 分流設定 | `.github/ISSUE_TEMPLATE/config.yml` 關閉空白 issue，並提供文件、發布檢查表、貢獻指南與 private security advisory 入口 | 已驗證 | 2026-05-10 新增 issue template config，讓開源試用者在公開回報前先看到文件與安全通報分流 |
| Virtual Office 貢獻指南 | `CONTRIBUTING.md` 說明 Virtual Office 回報路徑、好回報內容、敏感資訊停手線與安全漏洞分流 | 已驗證 | 2026-05-10 在既有貢獻指南補上 Virtual Office feedback 段落，並在 `SECURITY.md` 補充不要把敏感資訊放進公開 issue |
| Virtual Office PR 檢查 | `.github/PULL_REQUEST_TEMPLATE.md` 提醒 Virtual Office PR 需跑驗證、人工檢查頁面/文件、同步驗收清單並保留 Hermes 停手線 | 已驗證 | 2026-05-10 PR template 新增 Virtual Office verification block，要求列出 `pnpm run office:verify`、手動檢查與不安裝 Hermes、不 Run now、不啟用排程等確認 |
| 第一次貢獻 SOP | 中英文 first contribution SOP 說明第一次貢獻者適合的小範圍文件、UI 文字、檢查清單或開源導覽修正 | 已驗證 | 2026-05-10 新增 `docs/virtual-office-first-contribution.zh-TW.md` 與英文版，從 README、CONTRIBUTING、開源導覽、release checklist 與 maintainer daily SOP 連入，並保留 Hermes/Run now/排程停手線 |
| Virtual Office PR 審查 SOP | 中英文 PR review SOP 說明維護者合併前如何檢查 PR 範圍、驗證、文件/UI/檢查清單同步與安全停手線 | 已驗證 | 2026-05-10 新增 `docs/virtual-office-pr-review.zh-TW.md` 與英文版，從 README、CONTRIBUTING、PR template、開源導覽、release checklist 與 maintainer daily SOP 連入，並確認 Hermes gate 不被提前完成 |
| README Virtual Office 入口 | README 有 Virtual Office 段落，連到中英文入門、開源導覽、驗收清單與安全 issue form | 已驗證 | 2026-05-10 在 README Quickstart 後新增 Virtual Office 入口，包含 `pnpm run office:verify` 與不貼密鑰、不把 issue/PR 當成 Hermes 授權的提醒 |
| 開源目前狀態揭露 | README 與中英文開源導覽明確說明目前可試用，但 runtime skills、真人文件試讀與 Hermes 喚醒仍是 gate | 已驗證 | 2026-05-10 在 README 與中英文開源導覽新增目前狀態，避免把試用版誤解成理想版已全部完成 |
| 開源發布檢查表文件 | 中英文 release checklist 存在，發布前可逐項核對公開入口、GitHub 回報、PR、貢獻、安全、本機檔案與停手線 | 已驗證 | 2026-05-10 新增 `docs/virtual-office-release-checklist.zh-TW.md` 與英文版，並從 README、入門文件、開源導覽連入 |
| 開源試用發布 Go/Pause SOP | 中英文 release decision SOP 說明對外分享前最後的 Go / Pause / Internal Only 判斷 | 已驗證 | 2026-05-10 新增 `docs/virtual-office-release-decision.zh-TW.md` 與英文版，從 README、開源導覽、release checklist 與 maintainer daily SOP 連入，避免把可試用誤說成理想版完成 |
| 英文開機預覽復原 SOP | 英文文件有自己的開機與預覽復原流程，不再只指向中文 SOP | 已驗證 | 2026-05-10 新增 `docs/virtual-office-startup-sop.en.md`，英文入門、英文開源導覽、README 與 release checklist 都連到它，並保留不要刪資料庫、不要 Run now、不要喚醒 Hermes 的停手線 |
| 發布前試讀證據檢查 | release checklist 要求確認 `複製證據紀錄` 與真人試讀證據，避免把模板當成完成證明 | 已驗證 | 2026-05-10 中英文 release checklist 都補上 `複製證據紀錄`，並要求沒有非工程新手與英文讀者證據前，不宣稱文件 gate 已完成 |
| 開源發布備註草稿 | 中英文 release notes draft 說明可試用項目、仍保留 gate 與安全停手線 | 已驗證 | 2026-05-10 新增 `docs/virtual-office-release-notes-draft.zh-TW.md` 與英文版，並從 README、開源導覽與 release checklist 連入 |
| 開源前人工驗收總表 | 用單一總表收攏中文試讀、英文試讀、多次重開機與長時間穩定性，不為每次人工驗收新增流程卡 | 已驗證 | 2026-05-12 新增 `複製人工驗收總表`；總表要求記錄 `office:verify`、render smoke、中文/英文讀者證據、3 次重開機與 60 到 120 分鐘穩定性，並明確說明這不是 Hermes、Run now 或正式喚醒授權。 |
| 開源回報分流 SOP | 中英文 feedback triage SOP 說明收到回報後如何分流預覽、文件、UI、Hermes 前置、Routine 安全與安全通報 | 已驗證 | 2026-05-10 新增 `docs/virtual-office-feedback-triage.zh-TW.md` 與英文版，並從 README、開源導覽與 release checklist 連入 |
| 維護者日常檢查 SOP | 中英文 maintainer daily SOP 說明每天開工、回報分流、收工與停手線 | 已驗證 | 2026-05-10 新增 `docs/virtual-office-maintainer-daily.zh-TW.md` 與英文版，要求先跑 office:verify、敏感資訊先分流、收工前再驗證，不安裝/喚醒 Hermes |
| 回報轉工作項目 SOP | 中英文 feedback-to-work-items SOP 說明如何把已分流回報轉成文件、UI、驗收清單、進度紀錄或安全處理工作項目 | 已驗證 | 2026-05-10 新增 `docs/virtual-office-feedback-to-work-items.zh-TW.md` 與英文版，從 README、開源導覽、release checklist 與 maintainer daily SOP 連入，並保留 Hermes/Run now/排程停手線 |
| 試讀回饋彙整表 | 檢查清單可複製回饋彙整表，把真人試讀意見分成必修、建議修、可延後與安全風險 | 已驗證 | 2026-05-09 新增 `複製回饋彙整`，收到多位讀者回覆後可整理卡點、修改建議與是否有人誤解資料庫、密鑰、Run now 或 Hermes 安全界線 |
| 試讀回饋回填卡 | 檢查清單可複製回填卡，把試讀意見轉成文件修改、UI 文字、安全提醒與驗收狀態更新 | 已驗證 | 2026-05-09 新增 `複製回填卡`，提醒試讀邀請不等於文件已通過；需依讀者回饋回填文件、UI、安全風險與是否能更新部分完成狀態 |
| 試讀證據紀錄表 | 檢查清單可複製逐位試讀者的證據紀錄，避免把邀請或模板誤當成真人驗收 | 已驗證 | 2026-05-10 新增 `複製證據紀錄`，逐位記錄讀者背景、閱讀範圍、第一步理解、安全停手線、卡住原話與文件 gate 判斷依據 |
| 入門與開源文件說明文件回饋 | 中英文入門與開源導覽都說明可用 `複製文件回饋` 回報新手卡點 | 已驗證 | 2026-05-08 四份新手/開源文件補上文件回饋入口，讓人工閱讀 gate 有固定回報格式 |
| 入門與開源文件說明閱讀準備 | 中英文入門與開源導覽都說明可用 `複製閱讀準備` 安排新手試讀 | 已驗證 | 2026-05-08 四份新手/開源文件補上閱讀準備入口，讓文件人工閱讀 gate 有固定試讀範圍與問題 |
| 檢查清單入口穩定標記 | 主操作列與驗收摘要內的檢查清單按鈕都有固定測試標記 | 已驗證 | 2026-05-08 新增 `starter-action-acceptance-checklist` 與 `starter-action-open-acceptance-checklist`，讓後續瀏覽器驗收不會因按鈕文字重複而找錯 |
| Virtual Office 文件連結檢查 | 驗收時會檢查 Virtual Office 文件互相引用的文件是否存在 | 已驗證 | 2026-05-08 新增 `scripts/check-virtual-office-doc-links.mjs` 與 `pnpm run office:docs`，並掛進 `office:acceptance` |
| Virtual Office 英文文件可讀性檢查 | 驗收時會檢查英文 Virtual Office 文件是否殘留常見亂碼片段 | 已驗證 | 2026-05-08 `office:docs` 會掃描英文 Virtual Office 文件並阻擋常見 mojibake 片段，保護開源英文文件品質 |
| 新手可貼給 Codex 的求助文字 | 中文入門、開源導覽與開機 SOP 都提供安全求助範本 | 已驗證 | 2026-05-08 新增預覽健康、驗收進度、Routine safety 與 Hermes 檢查的貼上範本，明確限制不要刪資料庫、不要修改資料、不要喚醒 Hermes |
| 英文新手可貼給 Codex 的求助文字 | 英文入門與英文開源導覽都提供安全 help prompts | 已驗證 | 2026-05-08 英文文件新增 health check、acceptance summary、Routine safety 與 Hermes setup help prompts，限制不要刪資料庫、不要改資料、不要 wake Hermes |
| UI 可複製 Codex 求助文字 | 使用教學可一鍵複製安全求助文字 | 已驗證 | 2026-05-08 Office 使用教學新增 `貼給 Codex 的求助文字` 區塊與複製按鈕，限制只做健康檢查與安全說明，不刪資料庫、不改資料、不 Run now、不喚醒 Hermes |

## 4. 會議、討論與覆盤

| 檢查項目 | 驗收方式 | 目前狀態 | 開發紀錄 |
| --- | --- | --- | --- |
| 可以開討論任務 | `開討論任務` 會打開會議表單 | 已驗證 | 已確認表單顯示 |
| 可以指定議程 | 表單有議程與希望產出的結論 | 已驗證 | 已完成 |
| 可以指定主持人 | 表單可選主持人或自動選擇 | 已驗證 | 已完成 |
| 可以指定參與員工 | 表單可勾選參與者 | 已驗證 | 已完成 |
| 討論過程可覆盤 | 建立後 issue 描述要求留下討論過程、決策理由、問題與下一步 | 已驗證 | 2026-05-07 已建立沙盒會議 `Virtual Office Sandbox Review`，issue 描述含主持人、參與者、使用者介入規則與覆盤紀錄模板 |
| 使用者可以介入討論 | 從會議任務進入 issue 後可留言或補充決策 | 已驗證 | 2026-05-07 已在沙盒會議 issue 留下 `使用者介入驗收註記` 留言，確認使用者可把決策條件補進討論串 |
| 需介入會議有提示 | Office 會議清單可看出哪些討論需要使用者處理 | 已驗證 | 2026-05-07 沙盒會議描述含使用者介入規則且狀態為 `blocked`，代表可被 Office 會議區視為等待使用者處理的覆盤項目 |
| 會議介入判讀有說明 | Meetings & Review 區說明 `需介入` 代表需要使用者拍板，沒有標籤的會議可先當成覆盤紀錄 | 已驗證 | 2026-04-29 已新增固定的 `介入判讀` 提示，不需要先建立測試會議也能理解會議清單 |
| 會議任務有評論模板 | 員工回覆時有更固定的會議紀錄格式 | 已驗證 | 已在瀏覽器確認決策會議模板與預覽內容；建立時會寫入 issue 描述 |

## 5. 本地模型與 Hermes

| 檢查項目 | 驗收方式 | 目前狀態 | 開發紀錄 |
| --- | --- | --- | --- |
| UI 可呈現本地模型員工 | 員工卡顯示 adapter 類型，例如 Hermes 或 Codex local | 已驗證 | 已可依 adapter 分區 |
| Hermes adapter 預檢 | Office 新手操作檯顯示 hermes_local 是否已註冊、是否支援 skills、是否仍缺本機 CLI | 已驗證 | 2026-05-07 後端 `/api/adapters` 已列出 `hermes_local`，Office 加入 local model gate |
| Hermes CLI 動態環境檢查 | Office 自動呼叫 hermes_local 的 Test environment，只讀檢查 CLI、Python、模型與 API key 狀態 | 已驗證 | 2026-05-07 local model gate 不再寫死 CLI 狀態，改用後端環境測試結果顯示可使用、需確認或待安裝，並提供 `重新檢查` 入口 |
| Hermes 安裝前檢查提示 | Office 與 SOP 都列出預覽健康、Python/pip、Hermes CLI、模型憑證與沙盒邊界 | 已驗證 | 2026-05-07 local model gate 新增 `安裝前確認` 清單；SOP 補 Windows/PATH/python3 差異與 API key 安全提醒 |
| Hermes 安裝前最後檢查包 | Office 把安裝前一刻分成可自己先做、需要 Codex 陪同與現在先不要碰三區，並可複製停止條件 | 已驗證 | 2026-05-08 新增 `複製安裝前檢查包`；做到安裝 Hermes 前一刻，但不自動安裝、不填 API key、不喚醒模型 |
| Hermes 安裝前總檢回報 | Office 可複製安裝前總檢回報，把預覽、bridge、模型憑證、沙盒邊界與授權狀態整理成 READY/WAIT/PAUSE | 已驗證 | 2026-05-10 新增 `複製總檢`；READY 只代表可請使用者決定是否貼出安裝授權，不代表可安裝、填憑證、Run now 或喚醒模型 |
| Hermes 安裝前 WAIT 補齊包 | Office 可複製總檢 WAIT 時的補齊清單，列出缺項、下一個安全動作與仍禁止跨過的安裝/喚醒線 | 已驗證 | 2026-05-10 新增 `複製 WAIT 補齊`；只允許補非敏感狀態、命令預覽與 office:verify，不安裝、不填憑證、不建立 issue、不喚醒 |
| Hermes 安裝授權文字 | Office 可複製真正開始安裝前貼給 Codex 的授權文字，列出可做、不可做與停下詢問條件 | 已驗證 | 2026-05-08 新增 `複製安裝授權`；只有使用者明確貼出授權後才進安裝或設定，且仍禁止自動填憑證、建立喚醒 issue、Run now 或喚醒模型 |
| Hermes 安裝授權貼出前確認 | Office 可複製安裝授權句檢查卡，避免把繼續、下一步或好的誤判成可安裝授權 | 已驗證 | 2026-05-10 新增 `複製授權句檢查`；只有明確寫出 Hermes 安裝或設定範圍才可 ACCEPT，仍不填憑證、不建立 issue、不 Run now、不喚醒 |
| Hermes 安裝授權 WAIT/PAUSE 處理 | Office 可複製安裝授權句 WAIT/PAUSE 處理卡，未 ACCEPT 時只補明確授權或停下 | 已驗證 | 2026-05-10 新增 `複製授權 WAIT/PAUSE`；WAIT/PAUSE 不是安裝授權，不重試、不安裝、不填憑證、不喚醒 |
| Hermes 安裝授權 ACCEPT 交接 | Office 可複製安裝授權 ACCEPT 後的交接卡，限定只進逐條命令陪同，不擴張到憑證或喚醒 | 已驗證 | 2026-05-10 新增 `複製 ACCEPT 交接`；ACCEPT 後仍只執行使用者逐條同意的單一命令，不填憑證、不建立 issue、不 Run now、不喚醒 |
| Hermes ACCEPT 後第一命令預覽 | Office 可複製 ACCEPT 後第一條命令預覽卡，只列 HERMES-INSTALL-001 的目的、風險與停手線 | 已驗證 | 2026-05-10 新增 `複製第一命令預覽`；ACCEPT 後仍只列一條候選命令，不執行、不填憑證、不喚醒 |
| Hermes HERMES-INSTALL-001 單一命令同意 | Office 可複製 HERMES-INSTALL-001 單一命令同意卡，限定只同意或拒絕預覽中的第一條命令 | 已驗證 | 2026-05-11 新增 `複製第一命令同意`；實際命令必須和預覽完全一致，執行後立即停下回報結果，不延伸成下一條、憑證、Run now、排程或喚醒授權 |
| Hermes HERMES-INSTALL-001 單一命令結果 | Office 可複製 HERMES-INSTALL-001 執行後結果回報卡，要求檢查命令一致、安裝下載、敏感資訊與 PASS/WAIT/PAUSE | 已驗證 | 2026-05-11 新增 `複製第一命令結果`；未完成結果回報前不列下一條、不執行下一條，不一致、敏感資訊或越線行為時標成 PAUSE |
| Hermes HERMES-INSTALL-001 結果判讀 | Office 可複製 HERMES-INSTALL-001 結果判讀卡，把 PASS/WAIT/PAUSE 收斂到下一張安全卡、只讀補查或停下排查 | 已驗證 | 2026-05-11 新增 `複製第一命令判讀`；PASS 也不是 HERMES-INSTALL-002 或 HERMES-NEXT-001 授權，WAIT/PAUSE 都不執行下一條 |
| Hermes HERMES-INSTALL-001 循環總結 | Office 可複製 HERMES-INSTALL-001 循環總結，記錄預覽、同意、結果、判讀與下一張安全卡 | 已驗證 | 2026-05-11 新增 `複製第一循環總結`；只做交接與覆盤，不授權 HERMES-INSTALL-002、HERMES-NEXT-001、憑證、Run now、排程或喚醒 |
| Hermes HERMES-INSTALL-002 候選命令預覽 | Office 可複製 HERMES-INSTALL-002 候選命令預覽卡，只在第一循環 PASS 後列一條候選命令 | 已驗證 | 2026-05-11 新增 `複製第二命令預覽`；只列一條候選命令，不執行、不下載、不安裝、不填憑證、不建立 issue、不 Run now、不喚醒 |
| Hermes HERMES-INSTALL-002 單一命令同意 | Office 可複製 HERMES-INSTALL-002 單一命令同意卡，限定只同意或拒絕預覽中的第二條命令 | 已驗證 | 2026-05-11 新增 `複製第二命令同意`；實際命令必須和預覽完全一致，執行後立即停下回報結果，不延伸成下一條、憑證、Run now、排程或喚醒授權 |
| Hermes HERMES-INSTALL-002 單一命令結果 | Office 可複製 HERMES-INSTALL-002 執行後結果回報卡，要求檢查命令一致、安裝下載、敏感資訊與 PASS/WAIT/PAUSE | 已驗證 | 2026-05-11 新增 `複製第二命令結果`；未完成結果回報前不列下一條、不執行下一條，不一致、敏感資訊或越線行為時標成 PAUSE |
| Hermes HERMES-INSTALL-002 結果判讀 | Office 可複製 HERMES-INSTALL-002 結果判讀卡，把 PASS/WAIT/PAUSE 收斂到下一張安全卡、只讀補查或停下排查 | 已驗證 | 2026-05-11 新增 `複製第二命令判讀`；PASS 也不是 HERMES-INSTALL-003 或 HERMES-NEXT-001 授權，WAIT/PAUSE 都不執行下一條 |
| Hermes HERMES-INSTALL-002 循環總結 | Office 可複製 HERMES-INSTALL-002 循環總結，記錄預覽、同意、結果、判讀與下一張安全卡 | 已驗證 | 2026-05-11 新增 `複製第二循環總結`；只做交接與覆盤，不授權 HERMES-INSTALL-003、HERMES-NEXT-001、憑證、Run now、排程或喚醒 |
| Hermes HERMES-INSTALL-003 候選命令預覽 | Office 可複製 HERMES-INSTALL-003 候選命令預覽卡，只在第二循環 PASS 後列一條候選命令 | 已驗證 | 2026-05-11 新增 `複製第三命令預覽`；只列一條候選命令，不執行、不下載、不安裝、不填憑證、不建立 issue、不 Run now、不喚醒 |
| Hermes HERMES-INSTALL-003 單一命令同意 | Office 可複製 HERMES-INSTALL-003 單一命令同意卡，限定只同意或拒絕預覽中的第三條命令 | 已驗證 | 2026-05-11 新增 `複製第三命令同意`；實際命令必須和預覽完全一致，執行後立即停下回報結果，不延伸成下一條、憑證、Run now、排程或喚醒授權 |
| Hermes HERMES-INSTALL-003 單一命令結果 | Office 可複製 HERMES-INSTALL-003 執行後結果回報卡，要求檢查命令一致、安裝下載、敏感資訊與 PASS/WAIT/PAUSE | 已驗證 | 2026-05-11 新增 `複製第三命令結果`；未完成結果回報前不列下一條、不執行下一條，不一致、敏感資訊或越線行為時標成 PAUSE |
| Hermes HERMES-INSTALL-003 結果判讀 | Office 可複製 HERMES-INSTALL-003 結果判讀卡，把 PASS/WAIT/PAUSE 收斂到下一張安全卡、只讀補查或停下排查 | 已驗證 | 2026-05-11 新增 `複製第三命令判讀`；PASS 也不是 HERMES-INSTALL-004 或 HERMES-NEXT-001 授權，WAIT/PAUSE 都不執行下一條 |
| Hermes HERMES-INSTALL-003 循環總結 | Office 可複製 HERMES-INSTALL-003 循環總結，記錄預覽、同意、結果、判讀與下一張安全卡 | 已驗證 | 2026-05-11 新增 `複製第三循環總結`；只做交接與覆盤，不授權 HERMES-INSTALL-004、HERMES-NEXT-001、憑證、Run now、排程或喚醒 |
| Hermes HERMES-INSTALL-004 候選命令預覽 | Office 可複製 HERMES-INSTALL-004 候選命令預覽卡，只在第三循環 PASS 後列一條候選命令 | 已驗證 | 2026-05-11 新增 `複製第四命令預覽`；只列一條候選命令，不執行、不下載、不安裝、不填憑證、不建立 issue、不 Run now、不喚醒 |
| Hermes HERMES-INSTALL-004 單一命令同意 | Office 可複製 HERMES-INSTALL-004 單一命令同意卡，限定只同意或拒絕預覽中的第四條命令 | 已驗證 | 2026-05-11 新增 `複製第四命令同意`；實際命令必須和預覽完全一致，執行後立即停下回報結果，不延伸成下一條、憑證、Run now、排程或喚醒授權 |
| Hermes HERMES-INSTALL-004 單一命令結果 | Office 可複製 HERMES-INSTALL-004 執行後結果回報卡，要求檢查命令一致、安裝下載、敏感資訊與 PASS/WAIT/PAUSE | 已驗證 | 2026-05-11 新增 `複製第四命令結果`；未完成結果回報前不列下一條、不執行下一條，不一致、敏感資訊或越線行為時標成 PAUSE |
| Hermes HERMES-INSTALL-004 結果判讀 | Office 可複製 HERMES-INSTALL-004 結果判讀卡，把 PASS/WAIT/PAUSE 收斂到下一張安全卡、只讀補查或停下排查 | 已驗證 | 2026-05-11 新增 `複製第四命令判讀`；PASS 也不是 HERMES-INSTALL-005 或 HERMES-NEXT-001 授權，WAIT/PAUSE 都不執行下一條 |
| Hermes HERMES-INSTALL-004 循環總結 | Office 可複製 HERMES-INSTALL-004 循環總結，記錄預覽、同意、結果、判讀與下一張安全卡 | 已驗證 | 2026-05-11 新增 `複製第四循環總結`；只做交接與覆盤，不授權 HERMES-INSTALL-005、HERMES-NEXT-001、憑證、Run now、排程或喚醒 |
| Hermes HERMES-INSTALL-005 候選命令預覽 | Office 可複製 HERMES-INSTALL-005 候選命令預覽卡，只在第四循環 PASS 後列一條候選命令 | 已驗證 | 2026-05-11 新增 `複製第五命令預覽`；只列一條候選命令，不執行、不下載、不安裝、不填憑證、不建立 issue、不 Run now、不喚醒 |
| Hermes HERMES-INSTALL-005 單一命令同意 | Office 可複製 HERMES-INSTALL-005 單一命令同意卡，限定只同意或拒絕預覽中的第五條命令 | 已驗證 | 2026-05-11 新增 `複製第五命令同意`；實際命令必須和預覽完全一致，執行後立即停下回報結果，不延伸成下一條、憑證、Run now、排程或喚醒授權 |
| Hermes HERMES-INSTALL-005 單一命令結果 | Office 可複製 HERMES-INSTALL-005 執行後結果回報卡，要求檢查命令一致、安裝下載、敏感資訊與 PASS/WAIT/PAUSE | 已驗證 | 2026-05-11 新增 `複製第五命令結果`；未完成結果回報前不列下一條、不執行下一條，不一致、敏感資訊或越線行為時標成 PAUSE |
| Hermes HERMES-INSTALL-005 結果判讀 | Office 可複製 HERMES-INSTALL-005 結果判讀卡，把 PASS/WAIT/PAUSE 收斂到下一張安全卡、只讀補查或停下排查 | 已驗證 | 2026-05-11 新增 `複製第五命令判讀`；PASS 也不是 HERMES-INSTALL-006 或 HERMES-NEXT-001 授權，WAIT/PAUSE 都不執行下一條 |
| Hermes 安裝逐條命令通用流程 | Office 將 HERMES-INSTALL-001 到 005 的重複卡收攏成通用流程，後續不再新增無限編號卡 | 已驗證 | 2026-05-11 新增通用流程面板；使用者只看到預覽、同意、結果、判讀、總結五步，舊版編號卡保留追溯但不顯示 |
| Hermes 授權前二次確認 | Office 可複製 GO/PAUSE 二次確認卡，避免把安裝授權誤當成可直接執行或喚醒 | 已驗證 | 2026-05-09 新增 `複製二次確認`；貼出安裝授權前先確認預覽、命令、WSL2 路線、憑證與喚醒限制，未 GO 前不安裝、不設定、不喚醒 |
| Hermes 安裝前最終閘門 | Office 可複製安裝前最終閘門卡，要求預覽健康、交接完整、逐條命令鏈完整且無憑證/喚醒風險才可請使用者決定是否授權 | 已驗證 | 2026-05-10 新增 `複製最終閘門`；GO 也只代表可請使用者決定是否貼出安裝授權文字，不是安裝或命令執行授權 |
| Hermes 最終閘門判斷回覆 | Office 可複製最終閘門 GO/PAUSE 回覆卡，把原因、缺項、下一個最小動作與仍禁止事項固定留痕 | 已驗證 | 2026-05-10 新增 `複製閘門判斷`；GO 不是安裝授權，PAUSE 不是重試授權，仍不填憑證、不喚醒 |
| Hermes 最終閘門 GO 後交接 | Office 可複製最終閘門 GO 後交接卡，只允許請使用者閱讀並決定是否貼出安裝授權文字 | 已驗證 | 2026-05-10 新增 `複製 GO 後交接`；GO 後仍不安裝、不執行命令、不填憑證、不 Run now、不喚醒 |
| Hermes 最終閘門 PAUSE 修補交接 | Office 可複製最終閘門 PAUSE 後修補交接卡，只允許補最小缺項並回到閘門重判 | 已驗證 | 2026-05-10 新增 `複製 PAUSE 修補`；PAUSE 不是重試授權，不跳過閘門，不安裝、不填憑證、不喚醒 |
| Hermes 安裝陪同紀錄 | Office 可複製安裝陪同紀錄表，追蹤命令預覽、使用者同意、結果摘要與停止條件 | 已驗證 | 2026-05-09 新增 `複製陪同紀錄`；真正安裝時每個命令都需記錄目的、預覽、是否同意、結果與是否含敏感資訊 |
| Hermes 安裝前狀態快照 | Office 可複製安裝前交接快照，列出已準備項目、下一步順序與仍然禁止的動作 | 已驗證 | 2026-05-09 新增 `複製安裝前快照`；明確記錄尚未安裝、尚未填憑證、尚未喚醒 Hermes，以及下一步需先跑 office:verify |
| Hermes 安裝前流程導引 | Office 以 1 到 5 顯示安裝前順序：驗證、快照、檢查包、授權、陪同紀錄 | 已驗證 | 2026-05-09 新增 `Hermes 安裝前流程導引`，讓新手先照順序走，任何一步卡住就停下，不往安裝或喚醒推進 |
| Hermes 新手安裝前閱讀順序 | Office 可複製新手閱讀順序卡，把總檢、快照、檢查包、命令預覽與授權階梯排成安全路線 | 已驗證 | 2026-05-10 新增 `複製新手順序`；閱讀順序不是安裝授權、設定授權或喚醒授權，只讓新手照 0 到 6 的順序看卡片 |
| Hermes 安裝前風險判斷 | Office 會彙整預覽驗證、bridge、模型憑證、沙盒邊界與授權狀態，並可複製 GO/PAUSE 判斷 | 已驗證 | 2026-05-09 新增 `複製風險判斷`；只整理可做、先不要做與需補齊項目，不會安裝、不會填憑證、不會喚醒 Hermes |
| Hermes 下一個安全動作 | Office 依 bridge、模型憑證、沙盒資料與授權狀態提示下一個最小安全步驟，並可複製下一步 | 已驗證 | 2026-05-09 新增 `複製下一步`；只提示一個安全動作，不安裝、不填憑證、不建立任務、不喚醒 Hermes |
| Hermes 命令預覽請求 | Office 可複製安裝前命令預覽請求，要求 Codex 先列命令、目的、風險與停止條件，不得直接執行 | 已驗證 | 2026-05-09 新增 `複製命令預覽`；只要求列出命令表，若會安裝、寫檔、下載、改 PATH、設定或喚醒模型，都必須等使用者逐條同意 |
| Hermes 命令預覽表單 | Office 可複製第 1 階命令預覽表單，要求 Codex 用表格列出命令類型、風險與逐條同意欄位 | 已驗證 | 2026-05-10 新增 `複製命令表單`；只允許列命令，不允許執行，且任何寫檔、下載、改設定、憑證、Run now、schedule trigger 或喚醒都需標成 PAUSE |
| Hermes 逐條同意紀錄 | Office 可複製第 2 階逐條同意紀錄，要求每條命令單獨同意與回報結果 | 已驗證 | 2026-05-10 新增 `複製逐條同意`；沒有列在表內、沒有編號、或沒有明確同意的命令不可執行，不能用一次同意涵蓋全部命令 |
| Hermes 單一命令結果回報 | Office 可複製單一命令執行後回報卡，要求先判斷 PASS/WAIT/PAUSE，再決定是否能請使用者同意下一條 | 已驗證 | 2026-05-10 新增 `複製命令回報`；未回報結果、敏感資訊與下一步判斷前，不連續執行下一條命令 |
| Hermes 命令結果判讀 | Office 可複製單一命令結果判讀卡，把 PASS/WAIT/PAUSE 對應到下一個安全動作，避免連續執行 | 已驗證 | 2026-05-10 新增 `複製結果判讀`；PASS 不是下一條命令授權，WAIT/PAUSE 都不執行下一條命令 |
| Hermes 命令 PASS 後交接 | Office 可複製命令 PASS 後交接卡，提醒 PASS 只代表本條乾淨，下一條仍需命令預覽與逐條同意 | 已驗證 | 2026-05-10 新增 `複製 PASS 交接`；PASS 不會延伸成後續命令同意，不連續執行、不填憑證、不喚醒 |
| Hermes 命令 WAIT/PAUSE 處理 | Office 可複製命令 WAIT/PAUSE 處理卡，把 WAIT 限定為補資訊或只讀檢查，把 PAUSE 限定為停下排查 | 已驗證 | 2026-05-10 新增 `複製 WAIT/PAUSE`；WAIT/PAUSE 都不是重試授權或下一條命令授權，不重試、不硬跑下一條 |
| Hermes 安裝陪同循環總結 | Office 可複製安裝陪同循環總結，彙整本輪命令、最後判讀、敏感資訊檢查與下一張安全卡 | 已驗證 | 2026-05-10 新增 `複製陪同總結`；總結不是下一條命令授權，適合換對話、重開機、收工或交接目前狀態 |
| Hermes 安裝陪同收工交接 | Office 可複製安裝陪同收工交接，記錄關機前狀態、明天開工入口與仍未授權事項 | 已驗證 | 2026-05-10 新增 `複製收工交接`；收工交接不是明天授權，重開機後需先走開機/預覽復原 SOP |
| Hermes 安裝陪同開工接續判斷 | Office 可複製開工接續判斷卡，要求重開機後先確認預覽與收工交接，再決定回命令預覽、逐條同意或暫停 | 已驗證 | 2026-05-10 新增 `複製開工接續`；舊同意不可沿用，預覽 blocked 只走復原 SOP，PASS/WAIT/PAUSE 依安全卡接續 |
| Hermes 開工後下一條命令預覽 | Office 可複製開工後下一條命令預覽卡，只在 PASS HANDOFF 後列一條候選命令、目的、風險與停手線 | 已驗證 | 2026-05-10 新增 `複製下一命令預覽`；只列一條候選命令，不執行、不下載、不安裝、不填憑證、不喚醒 |
| Hermes 開工後單一命令同意 | Office 可複製開工後單一命令同意卡，限定只同意 HERMES-NEXT-001 且命令需完全符合預覽 | 已驗證 | 2026-05-10 新增 `複製單一命令同意`；只能同意或拒絕一條命令，執行後立即停下回報結果，不延伸成下一條授權 |
| Hermes 開工後單一命令結果 | Office 可複製 HERMES-NEXT-001 執行後結果回報卡，要求確認命令一致、敏感資訊、PASS/WAIT/PAUSE 與停止線 | 已驗證 | 2026-05-10 新增 `複製單一命令結果`；結果未回報前不執行下一條，不一致或含敏感資訊時標成 PAUSE |
| Hermes 開工後單一命令判讀 | Office 可複製 HERMES-NEXT-001 結果判讀卡，將 PASS/WAIT/PAUSE 收斂到回預覽、只讀補查或停下排查 | 已驗證 | 2026-05-10 新增 `複製單一命令判讀`；PASS 也不是下一條命令授權，WAIT/PAUSE 都不執行下一條 |
| Hermes 開工後單一命令循環總結 | Office 可複製 HERMES-NEXT-001 循環總結，記錄預覽、同意、結果、判讀與下一張安全卡 | 已驗證 | 2026-05-10 新增 `複製單一循環總結`；只做交接與覆盤，不授權下一條命令，不填憑證、不喚醒 |
| Hermes 安裝前最後交接包 | Office 可複製安裝前最後交接包，統整快照、檢查包、命令預覽、授權、陪同紀錄與停手線 | 已驗證 | 2026-05-09 新增 `複製最後交接`；只做交接與停手線，不代表安裝授權，不會安裝、不下載、不寫檔、不喚醒 Hermes |
| Hermes 授權階梯 | Office 把 Hermes 前置、命令預覽、安裝、設定與沙盒測試分成 0 到 4 階 | 已驗證 | 2026-05-10 新增 `複製授權階梯`；沒有明確授權階級時只停在第 0 階，每跨一階都要先回報結果，不會把安裝授權誤當成喚醒授權 |
| Hermes 安裝狀態再盤點 | SOP 記錄最新只讀盤點，區分 Hermes CLI/bridge 已可用與 provider/model/API key 尚未設定 | 已驗證 | 2026-05-10 只讀執行 `scripts\hermes-wsl.cmd --version` 與 `status`，確認 Hermes Agent v0.12.0、gateway running、jobs 0、sessions 0；目前不重裝、不填憑證、不喚醒 |
| Hermes provider/model 設定前判斷 | SOP 與 Office 說明設定前先選一個 provider/model，只整理非敏感選項 | 已驗證 | 2026-05-10 新增設定前判斷，列出 OpenRouter、OpenAI/Codex、Anthropic、Nous、Qwen、Kimi、MiniMax、Z.AI 等選項；只回報 provider/model，不貼 API key、不登入、不喚醒 |
| Hermes provider/model 選擇表 | Office 可複製非敏感 provider/model 選擇表，供使用者先決定模型來源 | 已驗證 | 2026-05-10 新增 `複製選擇表`；只填 provider、model、帳號/額度、是否由使用者自己在 Hermes 設定位置填 key、是否需要命令預覽，不收 API key、token、密碼或完整 `.env` |
| Hermes provider/model 選擇回覆檢查 | Office 可複製收到選擇表後的 Codex 檢查規則 | 已驗證 | 2026-05-10 新增 `複製檢查規則`；只檢查缺項、下一步與 GO/WAIT/PAUSE，不登入、不填 key、不執行命令、不喚醒 |
| Hermes provider/model 設定命令預覽 | Office 可複製 provider/model 設定前的命令預覽請求 | 已驗證 | 2026-05-10 新增 `複製命令預覽`；只列命令、人工步驟、風險與逐條同意欄，不執行、不登入、不填 key、不建立 issue、不 Run now、不喚醒 |
| Hermes provider/model 自行設定陪跑卡 | Office 可複製使用者自行設定 provider/model/API key 時的陪跑清單 | 已驗證 | 2026-05-10 新增 `複製自行設定陪跑`；使用者只在 Hermes 安全設定位置處理憑證，Codex 只接非敏感回報，不登入、不填 key、不改設定、不喚醒 |
| Hermes provider/model 設定後交接 | Office 可複製自行設定後的交接卡，讓使用者只回報 provider/model/key 是否已就緒與不含憑證錯誤 | 已驗證 | 2026-05-10 新增 `複製設定後交接`；只交接非敏感狀態，若出現 API key、完整 .env、登入/OAuth、Run now 或喚醒要求就 PAUSE |
| Hermes 授權總控狀態 | Office 可彙整 Hermes 第 0 到第 4 階與喚醒後覆盤狀態，提示目前停在哪一階與下一個最小安全動作 | 已驗證 | 2026-05-10 新增 `複製授權總控`；只整理階段狀態與停手線，不代表安裝、憑證、Run now、排程或喚醒授權 |
| Hermes 設定完成回報 | Office 可複製非敏感回報模板，讓使用者回報 bridge、model、provider 與 Test environment 狀態，但不貼 API key、token、密碼或完整 `.env` | 已驗證 | 2026-05-09 新增 `複製設定回報`；只收非敏感狀態，下一步也只做健康檢查或 Test environment，不建立喚醒 issue、不 Run now、不喚醒 Hermes |
| Hermes 設定回報判讀規則 | Office 可複製設定完成回報後的 Codex 判讀規則 | 已驗證 | 2026-05-10 新增 `複製判讀規則`；只判斷 GO read-only check / WAIT / PAUSE，不登入、不填 key、不改設定、不建立 issue、不 Run now、不喚醒 |
| Hermes 只讀檢查前確認 | Office 可複製只讀檢查前確認卡，確認回報無敏感資訊、只看 preview/bridge/status/Test environment，不改設定或喚醒 | 已驗證 | 2026-05-10 新增 `複製只讀前確認`；只有設定完成回報判定 GO 且無密鑰、登入、改設定、issue、Run now、排程或喚醒風險才進只讀檢查 |
| Hermes 只讀檢查請求 | Office 可複製 GO read-only check 後的只讀檢查請求 | 已驗證 | 2026-05-10 新增 `複製只讀檢查`；只允許 preview health、bridge、status 與 Test environment 摘要，不寫檔、不改設定、不建立 issue、不喚醒 |
| Hermes 只讀檢查結果交接 | Office 可複製只讀檢查跑完後的結果交接表，只貼 preview/bridge/status/Test environment 摘要，不貼 raw log 或密鑰 | 已驗證 | 2026-05-10 新增 `複製結果交接`；只交接非敏感狀態與錯誤類型，不貼完整 raw log、截圖、終端輸出、API key、完整 .env 或正式資料 |
| Hermes 只讀檢查結果判讀 | Office 可複製只讀檢查後的結果判讀規則 | 已驗證 | 2026-05-10 新增 `複製結果判讀`；只輸出 PASS/WARN/FAIL/PAUSE，即使 PASS 也只可準備第 4 階喚醒前檢查，不可直接喚醒 |
| Hermes 只讀 PASS 後交接 | Office 可複製只讀檢查 PASS 後的交接卡，明確限制下一步只能準備第 4 階喚醒前檢查，不代表可喚醒 | 已驗證 | 2026-05-10 新增 `複製 PASS 後交接`；PASS 只代表 preview/bridge/status/Test environment 乾淨，不是安裝、憑證、Run now、排程或喚醒授權 |
| Hermes 第 3 階設定檢查表 | Office 可複製第 3 階設定檢查表，區分可回報狀態、不可貼憑證與只讀 Test environment 條件 | 已驗證 | 2026-05-10 新增 `複製設定檢查`；若需要新命令要回到第 1 階命令預覽，不建立 issue、不 Run now、不啟用 schedule trigger、不喚醒 Hermes |
| Hermes 本機環境只讀盤點 | 不安裝、不喚醒，只確認 Windows 上 Python、pip、python3 與 hermes CLI 是否可見 | 已驗證 | 2026-05-07 Python 3.14.3、python3、pip 26.0.1 可用；`where hermes` 找不到，下一步才進 CLI 安裝 |
| Hermes Windows 安裝路線修正 | 發現 Native Windows / PyPI 路線不可用時，文件與 UI 改指向官方 WSL2 安裝路線 | 已驗證 | 2026-05-07 `python -m pip install hermes-agent` 找不到套件；官方文件寫明 Native Windows 不支援，改記錄 WSL2/Ubuntu + 橋接為下一步 |
| Hermes WSL bridge 可被後端檢查 | Windows 後端可透過 `scripts/hermes-wsl.cmd` 呼叫 WSL2 內的 Hermes CLI，並回報版本、模型與 API key 狀態 | 已驗證 | 2026-05-08 後端 Test environment 回傳 `Hermes Agent v0.12.0` 與 `Windows bridge: scripts/hermes-wsl.cmd`；目前狀態為 `warn`，原因是 Hermes model、`.env` 與 API key 尚未設定，尚未喚醒 agent |
| Hermes Ollama 本地模型橋接 | WSL2 內的 Hermes 可透過 Windows bridge 連到 Windows Ollama 的 OpenAI-compatible endpoint | 已驗證 | 2026-05-11 新增 `pnpm run hermes:ollama-bridge:restart`，WSL 端可讀到 `/v1/models`，Hermes 設為 `custom` provider、`qwen2.5:14b`；未填 API key、未喚醒 agent |
| Hermes Ollama 本地模式預檢通過 | `hermes_local` Test environment 能辨識 `Custom endpoint` + 本地 Ollama bridge，不再把沒有雲端 API key 誤判成阻塞 | 已驗證 | 2026-05-11 後端新增 `hermes_local_ollama_ready` 判斷，讀取 `.hermes-ollama-bridge-status.json`；Test environment 回傳 `pass`、版本與 bridge 皆為 info |
| Hermes 接入模式選擇 | Office 可顯示本機 Hermes、遠端 Hermes API 與尚未決定三條路，並可複製接入判斷卡 | 已驗證 | 2026-05-12 借鏡 hermes-desktop local/remote backend 分流；新增 `複製接入判斷`，只做路線選擇，不安裝、不連線、不保存憑證 |
| Hermes WSL2 設定路線可視化 | Office 顯示 bridge、模型/API key 與沙盒喚醒三段式狀態，讓新手知道下一步只設定 Hermes，不喚醒正式任務 | 已驗證 | 2026-05-08 `Hermes / local model gate` 新增 WSL2 設定路線，會在 bridge 可用但 model/API key 缺少時顯示待設定與先不要喚醒，並提醒不記錄 API key |
| Hermes WSL2 設定指引可複製 | Office 可複製 WSL2 設定路線、命令與安全邊界，供人工設定或交接 | 已驗證 | 2026-05-08 `Hermes WSL2 設定路線` 新增 `複製設定指引`；只複製 status、command 與安全提醒，不自動安裝、不填 API key、不喚醒 Hermes |
| Hermes Sandbox 員工草稿 | Office 可預填 Hermes Sandbox 員工，新建頁顯示 command、模型憑證與沙盒邊界確認 | 已驗證 | 2026-05-08 `建立 Hermes 草稿` 預填 `scripts/hermes-wsl.cmd`、`hermes_local` 與安全 prompt；New Agent 頁新增 `Hermes Sandbox 建立前確認`，提醒不要寫入 API key/token/密碼 |
| Hermes Sandbox 草稿確認包 | Office 可複製即將帶入新員工頁的 Hermes Sandbox 草稿內容，且與建立草稿使用同一份資料來源 | 已驗證 | 2026-05-09 新增 `複製草稿確認包`，列出 name、title、role、adapter、command、starter skills 與 prompt 草稿；只複製確認包，不建立員工、不填 API key、不喚醒模型 |
| Hermes Sandbox 測試員工已建立 | 實際建立專用 Hermes Sandbox/Test 員工，避免第一次喚醒掛到正式 PM 或正式專案 | 已驗證 | 2026-05-11 已建立 `Hermes Sandbox Engineer`，adapter 為 `hermes_local`、command 為 `scripts/hermes-wsl.cmd`、model 為 `qwen2.5:14b`、heartbeat 關閉、starter skills 已同步；尚未建立 issue、Run now 或喚醒 |
| Hermes 建立後檢查 | 建立 Hermes Sandbox 員工後，Office 顯示員工、starter skills、正式主管權限與 Test environment 狀態，並提供安全的 skills 預選入口 | 已驗證 | 2026-05-08 `Hermes / local model gate` 新增 `Hermes 建立後檢查`；`預選 Hermes skills` 只會打開技能精靈並預選 starter skills，仍需使用者手動按同步，不會建立 issue 或喚醒 agent |
| Hermes 建立後回報 | Office 可複製建立後檢查回報，整理 Sandbox 員工、skills 同步、正式主管與環境測試狀態 | 已驗證 | 2026-05-09 新增 `複製建立後回報`，把四張建立後檢查卡整理成 Markdown；只讀回報，不建立 issue、不 Run now、不啟用排程、不喚醒 Hermes |
| Hermes 沙盒喚醒模板 | Office 提供第一次喚醒用的 Sandbox/Test 任務模板，可複製但不會自動建立任務或喚醒 agent | 已驗證 | 2026-05-08 `Hermes / local model gate` 新增 `第一次沙盒喚醒計畫`，模板要求只回覆上下文、skills 與安全邊界，禁止修改檔案、正式任務與私密憑證 |
| Hermes 沙盒喚醒門檻 | Office 在第一次喚醒計畫中檢查環境狀態、Hermes Sandbox 員工、Sandbox/Test 專案與結束判斷 | 已驗證 | 2026-05-08 沙盒喚醒計畫新增 `沙盒對象` 門檻，未有 Hermes Sandbox 員工或測試專案時顯示先準備，避免把第一次喚醒掛到正式資料 |
| Hermes Sandbox issue 草稿 | 四個門檻通過後，Office 可預填第一次喚醒 issue，但仍需使用者手動建立，不自動喚醒 agent | 已驗證 | 2026-05-08 `第一次沙盒喚醒計畫` 新增 `預填 issue 草稿`，只有環境通過、Hermes Sandbox 員工與 Sandbox/Test 專案都存在時才可按；目前 model/API key 未設定所以保持停用 |
| Hermes Sandbox issue 已建立 | 已建立第一張 Sandbox/Test 前置 issue，供下一步喚醒前人工確認使用 | 已驗證 | 2026-05-11 建立 `AI-97978`：`[Sandbox/Test] Hermes first wake-up preflight - no Run now`，狀態為 `backlog`、指派給 `Hermes Sandbox Engineer`、專案為 `Virtual Office Sandbox`；建立後 active runs 仍為 0，未 Run now、未排程、未喚醒 |
| Hermes Sandbox issue 預填交接 | Office 可複製預填草稿交接卡，提醒 READY TO PREFILL 後只可打開與檢查 Sandbox/Test issue 草稿 | 已驗證 | 2026-05-10 新增 `複製預填交接`；不是建立授權、Run now 授權、排程授權或喚醒授權，下一步仍接 `複製建立前確認` |
| Hermes Sandbox issue 建立前確認 | Office 可複製預填草稿送出前確認表 | 已驗證 | 2026-05-10 新增 `複製建立前確認`；逐項確認標題、描述、Sandbox/Test 專案與 Hermes Sandbox/Test 負責人，不代按建立、不 Run now、不喚醒 |
| Hermes Sandbox issue 手動建立交接 | Office 可複製 READY TO CREATE MANUALLY 後的交接卡，確認只有使用者可手動建立 Sandbox/Test issue | 已驗證 | 2026-05-10 新增 `複製手動建立交接`；Codex 不代按建立、不送出表單、不 Run now、不排程、不喚醒，建立後接 `複製建立後觀察` |
| Hermes Sandbox issue 建立後觀察 | Office 可複製手動建立 Sandbox issue 後的觀察表 | 已驗證 | 2026-05-10 新增 `複製建立後觀察`；確認 issue、live runs、recovery 與員工狀態乾淨，只判斷 CLEAN/WAIT/PAUSE，不 Run now、不喚醒 |
| Hermes Sandbox issue CLEAN 交接 | Office 可複製建立後 CLEAN 交接卡，確認 CLEAN 只代表可準備喚醒授權文字 | 已驗證 | 2026-05-10 新增 `複製 CLEAN 交接`；CLEAN 不是 Run now、排程或喚醒授權，沒有使用者另行貼出一次性授權句前不喚醒 |
| Hermes 第 4 階入口交接 | Office 可複製只讀 PASS 後進入第 4 階前的交接卡，確認 PASS 只開啟喚醒前檢查，不開啟喚醒 | 已驗證 | 2026-05-10 新增 `複製第 4 階入口`；只允許檢查 Sandbox/Test 員工、專案與使用者確認，不建立 issue、不 Run now、不排程、不喚醒 |
| Hermes 第 4 階 WAIT 補齊包 | Office 可複製第 4 階入口 WAIT 時的補齊清單，只補 Sandbox/Test 員工、專案或使用者確認，不建立或喚醒 | 已驗證 | 2026-05-10 新增 `複製第 4 階 WAIT`；只允許補 Sandbox/Test 條件與非敏感只讀摘要，不預填 issue、不代按建立、不 Run now、不排程、不喚醒 |
| Hermes 第 4 階喚醒前檢查表 | Office 可複製第 4 階沙盒喚醒前檢查表，要求環境、Sandbox 員工、Sandbox/Test 專案與使用者確認都通過後才可預填 issue | 已驗證 | 2026-05-10 新增 `複製喚醒前檢查`；Office 只可預填 issue 草稿，不自動建立、不 Run now、不啟用 schedule trigger、不連續喚醒 |
| Hermes 喚醒前預填判讀 | Office 可複製第 4 階檢查後的預填判讀規則 | 已驗證 | 2026-05-10 新增 `複製預填判讀`；只判斷 READY TO PREFILL / WAIT / PAUSE，即使 READY 也只可開預填草稿，不自動建立或喚醒 |
| Hermes 第 4 階 READY 交接 | Office 可複製 READY TO PREFILL 後的交接卡，明確限制下一步只可開預填 Sandbox/Test issue 草稿，最後仍由使用者手動建立 | 已驗證 | 2026-05-10 新增 `複製第 4 階 READY`；READY 不是建立、Run now、排程或喚醒授權，只可預填草稿並接 `複製建立前確認` |
| Hermes Sandbox 喚醒授權文字 | Office 可複製第 4 階一次性 Sandbox/Test 喚醒授權文字 | 已驗證 | 2026-05-10 新增 `複製喚醒授權`；只授權單一 Sandbox/Test issue、單一 Hermes Sandbox/Test 員工，完成後停下覆盤，不 Run now、不排程、不接正式專案 |
| AI-97978 喚醒授權規格 | 第一次 Hermes Sandbox/Test 喚醒只接受明確點名 AI-97978 的一次性授權 | 已驗證 | 2026-05-11 已建立 `AI-97978` 後補上專用規格；`請繼續`、`下一步`、`可以` 都不算授權，授權句必須明確限制單一 issue、單一 Hermes Sandbox Engineer、完成後停下覆盤，不 Run now、不啟用排程、不接正式專案 |
| AI-97978 一次性喚醒覆盤 | 第一次授權喚醒、失敗修正與成功 retry 都已完成覆盤，且 Hermes 已在 issue 留下可追蹤留言 | 已驗證 | 2026-05-11 首次 run `ac907688-9bb3-4a35-8656-349e39a787e7` 失敗於相對路徑 `scripts\hermes-wsl.cmd`；retry run `281764c1-b8ff-423c-826a-e579985f40ea` 及 continuation `2f91bc6b-4078-45c7-99c9-cf8cb9e7f553` 顯示 `.cmd` 無法穩定轉送多行 prompt。改用 `scripts\hermes-wsl.exe` bridge 並設定 Hermes 64K context 後，授權 retry run `ed6de5fa-5807-4a44-a96e-2da0f3b051e3` 成功，Hermes session `20260511_131730_5c90ed`，由 `Hermes Sandbox Engineer` 在 `AI-97978` 留言列出 skills 並確認只處理 Sandbox/Test 類任務。完成後 Hermes 員工已暫停，`AI-97978` 已收尾為 `done`。 |
| Hermes 喚醒授權貼出前確認 | Office 可複製授權句檢查卡，確認使用者貼出的句子必須明確限定一次性 Sandbox/Test 喚醒 | 已驗證 | 2026-05-10 新增 `複製授權句檢查`；模糊句如「可以」「繼續」「幫我跑」不可視為喚醒授權，未 ACCEPT 前不喚醒 |
| Hermes 喚醒授權 ACCEPT 交接 | Office 可複製授權句 ACCEPT 後的最後交接卡，確認只進單次 Sandbox/Test 喚醒，不擴張授權 | 已驗證 | 2026-05-10 新增 `複製 ACCEPT 交接`；ACCEPT 不是 Run now、排程、正式專案或連續喚醒授權，完成後必須停下覆盤 |
| Hermes 一次性喚醒前最後確認 | Office 可複製實際喚醒前最後確認卡，核對單一 issue、單一員工與無 running/live run/recovery 風險 | 已驗證 | 2026-05-10 新增 `複製喚醒前最後確認`；任一項不通過就停下，不 Run now、不排程、不接正式專案、不連續喚醒 |
| Hermes 一次性喚醒執行交接 | Office 可複製單次喚醒執行交接卡，確認執行範圍只限一次 Sandbox/Test 喚醒並要求完成後停下覆盤 | 已驗證 | 2026-05-10 新增 `複製喚醒執行交接`；交接卡不自動喚醒，完成後授權即結束，不延伸到下一次任務 |
| Hermes 一次性喚醒完成停手 | Office 可複製喚醒完成後停手交接卡，要求回到喚醒後檢查與覆盤，完成前不進下一個任務 | 已驗證 | 2026-05-10 新增 `複製完成停手交接`；完成後不建立第二個 issue、不再次喚醒、不 Run now、不排程、不接正式專案 |
| Hermes 喚醒後檢查面板 | Office 只讀顯示 Hermes 員工狀態、Hermes live runs、recovery issues 與覆盤 issue，讓第一次沙盒喚醒後有固定判讀位置 | 已驗證 | 2026-05-08 `Hermes / local model gate` 新增 `喚醒後檢查面板`；目前不修改資料，只讀列出四個訊號，供未來真喚醒後確認是否可進下一步 |
| Hermes 喚醒後覆盤回報 | Office 可複製沙盒喚醒後覆盤回報，整理回覆是否可讀、員工是否卡住、live runs/recovery 是否乾淨與是否可進下一步 | 已驗證 | 2026-05-10 新增 `複製喚醒後覆盤`；若有 running/error、live run 殘留、recovery issues 或憑證外洩疑慮，先停下，不進正式專案 |
| Hermes 喚醒後覆盤判讀 | Office 可複製喚醒後覆盤判讀卡，把結果限定為 CLEAN、WAIT 或 PAUSE；CLEAN 也先停下記錄 | 已驗證 | 2026-05-10 新增 `複製覆盤判讀`；CLEAN 不是下一次喚醒授權，若要下一個 Hermes 任務需重走 Sandbox/Test 範圍與授權流程 |
| Hermes 覆盤 CLEAN 記錄交接 | Office 可複製 CLEAN 後記錄交接卡，把乾淨結果寫進進度與驗收清單，不當成下一次授權 | 已驗證 | 2026-05-10 新增 `複製 CLEAN 記錄`；CLEAN 記錄不是下一次喚醒授權，不建立第二個 issue、不 Run now、不排程、不接正式專案 |
| Hermes 覆盤 WAIT/PAUSE 處理 | Office 可複製覆盤 WAIT/PAUSE 處理卡，限制 WAIT 只等待或只讀重查、PAUSE 只停下排查 | 已驗證 | 2026-05-10 新增 `複製 WAIT/PAUSE 處理`；WAIT/PAUSE 都不是下一次喚醒授權，不建立第二個 issue、不再次喚醒、不 Run now |
| Hermes 下一任務重啟入口 | Office 可複製下一個 Hermes 任務重啟入口卡，要求重新走 Sandbox/Test 範圍、檢查與授權流程 | 已驗證 | 2026-05-10 新增 `複製下一任務入口`；上一次 CLEAN 與授權句不可沿用，不連續喚醒、不建立多個 issue、不接正式專案 |
| Hermes 沙盒循環總結 | Office 可複製一次 Sandbox/Test Hermes 任務循環總結，彙整狀態、結果與下一個安全動作 | 已驗證 | 2026-05-10 新增 `複製沙盒循環總結`；總結不是下一次喚醒授權，適合教學、開源文件與隔天交接 |
| Hermes 喚醒操作紀錄 | Office 可複製一次性 Sandbox/Test 喚醒 Markdown 紀錄表，讓真測時逐項勾選設定前、建立前、喚醒前與完成後檢查 | 已驗證 | 2026-05-08 `Hermes / local model gate` 新增 `一次性沙盒喚醒操作紀錄`，可複製 Markdown 勾選表，包含停止條件與喚醒後四個訊號 |
| Hermes 開始設定判斷 | Office 合併預覽驗證、adapter、環境、沙盒員工、沙盒專案與 starter skills，顯示可以開始或先暫緩 | 已驗證 | 2026-05-08 `Hermes / local model gate` 新增 `Hermes 開始設定判斷` 與 `複製開始判斷`，條件未齊前只做設定與檢查，不建立喚醒 issue、不 Run now、不接正式工作 |
| Hermes 喚醒前使用者確認 | 即使前置條件都通過，預填第一次喚醒 issue 前仍需使用者手動勾選 Sandbox/Test 確認 | 已驗證 | 2026-05-08 `預填 issue 草稿` 需同時通過環境、Hermes Sandbox 員工、Sandbox/Test 專案與 `hermes-wakeup-user-confirmation`；未確認前不建立喚醒 issue、不 Run now、不接正式工作 |
| Hermes 安裝與環境測試 SOP | 新手可照文件完成 Python、CLI、API key、Test environment 與沙盒喚醒前檢查 | 已驗證 | 2026-05-07 新增 `docs/virtual-office-hermes-sop.zh-TW.md`，並在入門文件與 Office 教學文件地圖加入入口 |
| Hermes agent 可被喚醒執行 | 建立任務後 Hermes 能實際接手處理 | 已驗證 | 2026-05-11 在明確一次性授權下，`Hermes Sandbox Engineer` 只對 `AI-97978` 執行 Sandbox/Test 喚醒；run `ed6de5fa-5807-4a44-a96e-2da0f3b051e3` 成功，exit code 0，並在 issue 留下可覆盤留言。heartbeat 仍保持關閉，不 Run now、不排程、不接正式專案。 |
| Hermes 第二沙盒任務準備 | 第一次 Sandbox/Test 喚醒成功後，Office 可準備第二個沙盒任務但不自動喚醒 | 已驗證 | 2026-05-11 新增 `複製第二沙盒準備`；此卡只整理候選 issue、測試目的、任務邊界、建立前檢查與 READY/WAIT/PAUSE 判斷，不 Run now、不排程、不開 heartbeat、不沿用 AI-97978 授權。 |
| Hermes 第二沙盒 issue 草稿 | 第一次 Sandbox/Test 喚醒成功後，Office 可複製或預填第二個受控 issue 草稿，但仍不喚醒 Hermes | 已驗證 | 2026-05-11 新增 `複製第二 issue 草稿` 與 `預填第二 issue`；內容明列只建立待辦草稿、不得沿用 AI-97978 授權、建立後先停下覆盤、不 Run now、不排程、不開 heartbeat。 |
| Hermes 第二沙盒 issue 覆盤 | 第二個 Sandbox/Test issue 建立後，可確認它仍只是待辦草稿且沒有喚醒 Hermes | 已驗證 | 2026-05-11 新增 `複製第二 issue 覆盤`；覆盤表檢查 issue 狀態、專案、負責人、無 queued/running Hermes runs、無 recovery、無 Run now、無排程、heartbeat scheduler 仍為 false。 |
| Hermes 第二沙盒授權模板 | 第二個 Sandbox/Test issue 若未來要真的喚醒，Office 可提供填空式一次性授權模板，但模板本身不算授權 | 已驗證 | 2026-05-11 新增 `複製第二授權模板`；要求填入單一 issue、單一 Sandbox/Test 員工、完成後停下覆盤，並明列不沿用 AI-97978、不 Run now、不排程、不開 heartbeat、不連續喚醒。 |
| Hermes 第二沙盒授權判讀 | 第二次 Sandbox/Test 授權句貼出後，Office 可先判斷 ACCEPT/WAIT/PAUSE，未 ACCEPT 前不喚醒 Hermes | 已驗證 | 2026-05-11 新增 `複製第二授權判讀`；要求確認單一 issue、單一員工、一次性、完成後停下覆盤、無 Run now/排程/heartbeat/正式資料/連續喚醒，且不可沿用 AI-97978。 |
| Hermes 第二沙盒喚醒前最後確認 | 第二次授權判讀 ACCEPT 後，Office 可再次確認單一 issue、單一員工與現場狀態乾淨，避免直接喚醒 | 已驗證 | 2026-05-11 新增 `複製第二最後確認`；再次檢查 issue 不是 AI-97978、狀態不是 running/done/cancelled、Hermes 員工 paused/manual、Backend/Frontend OK、無 queued/running runs、無 recovery、無排程、無敏感資料。 |
| AI-98227 第二沙盒喚醒覆盤 | 第二個 Sandbox/Test issue 已在明確一次性授權下完成安全喚醒、留言與停手覆盤 | 已驗證 | 2026-05-11 使用者明確授權後，只對 `AI-98227` 由 `Hermes Sandbox Engineer` 做一次 Sandbox/Test 喚醒；run `515b2fe4-b3b3-4586-84b1-af8cd03cca79` 成功，exit code 0，Hermes session `20260511_172324_7880d1`，留言 `932886db-66cb-45eb-a283-5587741a8369` 已寫回 issue。完成後 Hermes 員工已暫停，`AI-98227` 已收尾為 `done`，active run 為空，heartbeat scheduler 仍為 false。 |
| Hermes runtime skill key 回報證據 | Hermes 回覆中需明確列出 Paperclip runtime skill key，才能證明模型端真的看見注入的 skills | 已驗證 | 2026-05-12 `AI-98530` 真測通過：Hermes 回覆包含 `Paperclip runtime capability keys` 段落，逐字列出 7 個 exact keys，並逐項標記 `used` 或 `visible but not used`；完成後 Hermes `paused/manual`、active run 為空、company live runs 為 0。 |
| 正式 Hermes 喚醒 preflight | 正式喚醒前只讀確認 issue、agent、active run、live runs、heartbeat、Hermes command 與 runtime capability keys | 已驗證 | 2026-05-18 補強 `pnpm run office:hermes-production-preflight`：拒絕 `[ISSUE]` / `[AGENT]` placeholder，只讀檢查，不建立 issue、不 checkout、不喚醒 Hermes；若目標員工缺少可執行 Hermes command/bridge，會在喚醒前停下。 |
| Hermes runtime skill key 回覆提示 | Hermes adapter 會要求完成留言逐字列出 exact Paperclip runtime skill keys，避免只回通用工具名 | 已驗證 | 2026-05-11 `hermes_local` runtime skills 注入文字已補上 `Completion comment requirement`，要求 Hermes 在 `Paperclip runtime skills` 段落列出 exact skill keys，並區分 used / visible but not used；`adapter-registry.test.ts` 覆蓋 task body 與自訂 promptTemplate 兩條路徑。 |
| AI-98228 skill key 驗證 issue 準備 | 已建立下一張只供明確一次性授權使用的 Sandbox/Test issue，用來驗證 exact runtime skill key 回報 | 已驗證 | 2026-05-11 建立 `AI-98228`：`[Sandbox/Test] Hermes exact runtime skill key proof - no Run now`，位於 `Virtual Office Sandbox`，指派給 `Hermes Sandbox Engineer`，狀態為 `backlog`。建立後 Hermes 員工仍為 `paused/manual`、heartbeat false、無留言、無 checkout run、無 active run；內容要求未來授權喚醒時必須回覆 `Paperclip runtime skills` 段落與 exact skill keys。 |
| AI-98228 skill key 驗證喚醒覆盤 | 已完成一次性 Sandbox/Test 喚醒、停手與失敗覆盤 | 已驗證 | 2026-05-11 使用者明確授權後，`AI-98228` 產生唯一 run `152b163d-619a-443e-ab7f-2665a525198f`，exit code 0，Hermes session `20260511_182129_cde8ee`，留言 `717d3ecb-99c1-4f1c-bdae-50bd21158ed1`。完成後 Hermes 已暫停、issue 已 done、active run 為空、heartbeat false。該輪 exact key 未通過，但缺口已由後續 prompt/preflight 修正與 `AI-98530` 真測補齊。 |
| Hermes runtime skill prompt 只讀 preflight | 授權下一張 Sandbox/Test 前，先只讀確認下一次 Hermes 模型輸入會包含 runtime skill prompt 與 exact skill keys | 已驗證 | 2026-05-11 新增並執行 `pnpm run office:hermes-preflight`；它只讀 backend health、Hermes Sandbox Engineer 與 skills snapshot，不建立 issue、不 checkout、不 wakeup。結果確認注入目標為 custom promptTemplate，`Paperclip Runtime Skills`、`Completion comment requirement`、`exact skill keys` 與 7 個 desired exact skill keys 都會進入 prompt。 |
| AI-98229 preflight proof issue 準備 | 已建立下一張完全測試用 Sandbox/Test issue，用來驗證 preflight 後 Hermes 回覆 exact runtime skill keys | 已驗證 | 2026-05-11 建立 `AI-98229`：`[Sandbox/Test] Hermes runtime skill prompt preflight proof - no Run now`，位於 `Virtual Office Sandbox`，指派給 `Hermes Sandbox Engineer`，狀態為 `backlog`。建立後確認 comments 為空、active run 為空、Hermes 仍為 paused/manual、Backend health OK；尚未授權喚醒。 |
| AI-98229 preflight proof 喚醒覆盤 | 已完成一次性 Sandbox/Test 喚醒、停手與 prompt 組裝路徑覆盤 | 已驗證 | 2026-05-11 使用者明確授權後，只對 `AI-98229` 做一次喚醒；run `6e25b796-5fe8-49ef-ac8f-b696f267d900` 成功，Hermes session `20260511_185425_434f38`，留言 `712bc46e-a272-473e-a073-c878e377470d` 已寫回。完成後 Hermes 已暫停、issue 已 done、active run 為空。該輪回覆與 run log 仍沒有 exact runtime skill keys；後續修正 `hermes_local` execute 並由 `AI-98530` 驗證真實模型回覆。 |
| AI-98230 fixed prompt proof issue 準備 | 已建立下一張完全測試用 Sandbox/Test issue，用來驗證修正後真實 execute 路徑是否帶入 exact runtime skill keys | 已驗證 | 2026-05-11 建立 `AI-98230`：`[Sandbox/Test] Hermes fixed runtime skill prompt proof - no Run now`，位於 `Virtual Office Sandbox`，指派給 `Hermes Sandbox Engineer`，狀態為 `backlog`。建立前 `office:hermes-preflight` 通過；建立後確認 comments 為空、active run 為空、Hermes 仍為 paused/manual、Backend health OK；尚未授權喚醒。 |
| AI-98230 fixed prompt proof 喚醒覆盤 | 已完成一次性 Sandbox/Test 喚醒、停手與 task context 修正覆盤 | 已驗證 | 2026-05-11 使用者明確授權後，只對 `AI-98230` 做一次喚醒；run `941dcbdf-e330-4f69-874e-d7d2808eaf11` 成功，Hermes session `20260511_195011_5d1b55`，留言 `796676a9-9b48-4e71-ba85-a357baa3be32` 已寫回。完成後 Hermes 已暫停、issue 已 done、active run 為空。該輪仍未列 exact runtime skill keys；後續修正 custom promptTemplate 與 final contract ordering，並由 `AI-98530` 補上證據。 |
| AI-98231 taskBody prompt proof issue 準備 | 已建立下一張完全測試用 Sandbox/Test issue，用來驗證 taskBody prompt routing 修正後的真實 Hermes 輸入 | 已驗證 | 2026-05-11 建立 `AI-98231`：`[Sandbox/Test] Hermes taskBody runtime skill prompt proof - no Run now`，位於 `Virtual Office Sandbox`，指派給 `Hermes Sandbox Engineer`，狀態為 `backlog`。建立前 `office:hermes-preflight` 通過且顯示 injection target 為 taskBody；建立後確認 comments 為空、active run 為空、Hermes 仍為 paused/manual、Backend health OK；尚未授權喚醒。 |
| AI-98231 taskBody prompt proof 喚醒覆盤 | 已完成一次性 Sandbox/Test 喚醒、停手與 context-only issue fallback 覆盤 | 已驗證 | 2026-05-11 使用者明確授權後，只對 `AI-98231` 做一次喚醒；run `ef52bc26-20f3-40ac-97c6-cfd27bcebd50` 成功，Hermes session `20260511_201500_55b709`，留言 `05a64d8d-93d8-48e5-9ab1-928c66fbc7f1` 已寫回。完成後 Hermes 已暫停、issue 已 done、active run 為空。該輪 exact keys 未通過；後續 fallback 與 prompt ordering 修正已由 `AI-98530` 真測驗證。 |
| AI-98232 task config fallback proof issue 準備 | 已建立下一張完全測試用 Sandbox/Test issue，用來驗證 AI-98231 後的 task config fallback 修正 | 已驗證 | 2026-05-11 建立 `AI-98232`：`[Sandbox/Test] Hermes task config fallback proof - no Run now`，位於 `Virtual Office Sandbox`，指派給 `Hermes Sandbox Engineer`，狀態為 `backlog`。建立前 `office:hermes-preflight` 通過且顯示 `Paperclip issue context fallback enabled`；建立後確認 comments 為空、active run 為空、checkout run 為空、Hermes 仍為 paused/manual；尚未授權喚醒。 |
| AI-98232 task config fallback proof 喚醒覆盤 | 已完成一次性 Sandbox/Test 喚醒、停手與 authToken-independent 注入覆盤 | 已驗證 | 2026-05-11 使用者明確授權後，只對 `AI-98232` 做一次喚醒；run `7aed7835-6a18-427e-9f84-22f1c01e8068` 成功，Hermes session `20260511_210524_c2e7ee`，留言 `22254972-838f-48a6-87de-83c160090158` 已寫回。完成後 Hermes 已暫停、issue 已 done、active run 為空。該輪 exact keys 未通過；後續 authToken-independent path 與 final contract ordering 已由 `AI-98530` 真測補齊。 |
| AI-98233 authToken-independent prompt proof issue 準備 | 已建立下一張完全測試用 Sandbox/Test issue，用來驗證 AI-98232 後 authToken 缺席時仍會注入 runtime prompt | 已驗證 | 2026-05-11 建立 `AI-98233`：`[Sandbox/Test] Hermes authToken-independent runtime prompt proof - no Run now`，位於 `Virtual Office Sandbox`，指派給 `Hermes Sandbox Engineer`，狀態為 `backlog`。建立前 `office:hermes-preflight` 通過；建立後確認 comments 為空、active run 為空、checkout run 為空、Hermes 仍為 paused/manual；尚未授權喚醒。 |
| AI-98234 prompt routing diagnostic proof 喚醒覆盤 | 已完成一次性 Sandbox/Test 喚醒、停手與舊後端殘留清理覆盤 | 已驗證 | 2026-05-11 使用者明確授權後，只對 `AI-98234` 做一次喚醒；run `19e00a29-33fc-4c67-9d6a-b0fe5cdc419f` 成功，Hermes session `20260511_223916_c6f61f`，留言 `435a3955-fe9d-47c2-8d04-91d11f00fd4f` 已寫回。完成後 Hermes 已暫停、issue 已 done、checkoutRunId 已清空。該輪沒有診斷標記；覆盤發現舊 Paperclip 後端行程殘留，已補強 `office:restart` 遞迴清理，後續 `AI-98530` 在乾淨後端下完成真測。 |
| AI-98235 post-cleanup diagnostic issue 準備 | 已建立下一張完全測試用 Sandbox/Test issue，用來驗證舊後端清理後的 prompt routing 診斷 | 已驗證 | 2026-05-11 建立 `AI-98235`：`[Sandbox/Test] Hermes post-cleanup prompt routing diagnostic proof - no Run now`，issue id `12584bcd-de1e-40a0-8d09-ed3232cca484`，位於 `Virtual Office Sandbox`，指派給 `Hermes Sandbox Engineer`，狀態為 `backlog`。建立後確認 comments 為空、runs 為空、checkoutRunId / executionRunId / activeRun 皆為空，Hermes 仍為 paused/manual；`office:hermes-preflight` 顯示 READY。尚未授權喚醒。 |
| 預覽重啟會清掉舊後端 | `office:restart` 會遞迴清理舊 Paperclip 後端 process tree，避免新程式碼被舊 3100 後端遮住 | 已驗證 | 2026-05-11 補強 `scripts/start-virtual-office-preview.ps1`：新增 `Get-ProcessDescendantIds`，`Stop-StuckBackendProcesses` 分批停止目標行程與子行程，並修正 stuck backend 掃描函式輸出。實測 `office:restart` 後只剩一組新後端 process tree，`office:check` 顯示 Backend / Frontend OK。 |
| 新手知道如何設定模型 | 教學文件與 UI 說明本地模型與環境需求 | 已驗證 | 2026-04-29 已在新手教學與中文 getting started 補上本地模型準備檢查，包含模型服務、adapter、測試任務、recovery issues 與 heartbeat 安全邊界 |

## 6. 開源與教學

| 檢查項目 | 驗收方式 | 目前狀態 | 開發紀錄 |
| --- | --- | --- | --- |
| 有中文入門文件 | `docs/virtual-office-getting-started.zh-TW.md` 存在 | 已驗證 | 已新增 |
| 文件能讓非工程新手看懂 | 內容避免只講技術名詞，說明使用流程與目的 | 已驗證 | 2026-05-15 使用者已讀文件並回報：第一個安全步驟清楚、知道不貼密鑰/不 Run now/不喚醒 Hermes/不啟用排程、沒有卡住；中文非工程新手可讀性 gate 可推進到已驗證 |
| 有驗收檢查表 | 本文件存在並會持續更新 | 已驗證 | 2026-04-28 新增 |
| 英文文件真人回饋 gate | 提供給更多開源使用者，並避免在沒有真人英文回饋前宣稱英文文件已完全完成 | 部分完成 | English-reader feedback gate：已新增英文文件並通過自動文件檢查；2026-05-15 使用者確認中文 UI 對照與安全提醒清楚；英文語氣、自然度與中文 UI 對照仍待母語英文或熟練英文使用者回饋後再優化，暫不推進到已驗證 |
| 英文入門文件無亂碼 | 英文 getting started 不應殘留亂碼 UI 標籤，並需能獨立說明安全流程 | 已驗證 | 2026-05-08 已重寫 `docs/virtual-office-getting-started.en.md`，補齊 Routine safety、Local Model Readiness、Documentation Map 與可讀狀態說明 |
| 英文文件 UI 標籤對照 | 英文入門與開源導覽列出常見中文 UI 標籤與英文意思，方便英文讀者對照畫面 | 已驗證 | 2026-05-09 新增 `Common UI labels`，涵蓋檢查清單、剩餘路線、技能載入、技能交接、文件回饋、閱讀準備、新手自評與開工/預覽安全按鈕 |
| 英文文件試讀包 | 檢查清單可複製英文讀者試讀包，請讀者檢查英文語氣、中文 UI 對照與安全提醒 | 已驗證 | 2026-05-09 新增 `複製英文試讀包`，請英文讀者檢查 getting started、open-source README、routine safety、UI label glossary 與 Hermes/Run now 安全邊界 |
| 英文文件完成判斷卡 | 檢查清單可複製英文文件完成判斷，區分自動可讀性檢查已通過與仍需英文讀者人工確認 | 已驗證 | 2026-05-10 新增 `複製英文完成判斷`；沒有真人英文讀者回饋前，不把英文文件 gate 視為完成 |
| 英文文件有人工閱讀檢查點 | 英文入門文件列出開源前需要確認的語氣、資料變更、本地模型安全邊界與中英 UI 標籤 | 已驗證 | 2026-04-30 已在英文 getting started 補上 `English Documentation Review Notes`，並修正英文開源導覽中的檢查清單按鈕說明 |
| UI 有新手名詞翻譯 | 使用教學把 agent、skill、project、issue、workflow、heartbeat 翻成辦公室語言 | 已驗證 | 2026-04-30 已在 Office 使用教學加入 `新手名詞翻譯`，降低非工程新手第一次閱讀 Paperclip 名詞的門檻 |
| UI 有第一次使用路線 | 使用教學把初次使用分成只看介面、沙盒測試與正式使用 | 已驗證 | 2026-04-30 已在 Office 使用教學加入 `第一次使用建議路線`，讓新手知道何時只看、何時測試、何時才進入正式專案 |
| UI 有繼續前狀態判斷 | 使用教學用綠燈、黃燈、紅燈提示何時可繼續、何時先記錄、何時停下確認 | 已驗證 | 2026-04-30 已在 Office 使用教學加入 `繼續前看三個訊號`，降低新手誤按資料變更或自動喚醒的風險 |
| UI 與開源導覽有安裝前確認 | 使用教學與開源導覽列出必要條件、可先跳過項目與卡住時處理方式 | 已驗證 | 2026-05-05 已在 Office 使用教學與中英文開源導覽加入 `開源安裝前先確認`，讓非工程新手先知道準備範圍與安全跳過項目 |
| 有明確非商轉定位 | 文件說明這是個人/新手友善工具，不是 SaaS 模板 | 已驗證 | 中文入門文件已寫入 |
| UI 可找到教學文件地圖 | 使用教學列出每份 Virtual Office 文件的用途 | 已驗證 | 2026-04-29 已在 `使用教學` 加入 `教學文件地圖`，列出中英文入門、開源導覽、驗收清單與開機 SOP |
| 有中英文開源導覽草稿 | 提供可放到 README 或專案首頁的簡短導覽 | 已驗證 | 2026-04-29 已新增 `docs/virtual-office-open-source-readme.zh-TW.md` 與 `docs/virtual-office-open-source-readme.en.md`，整理適合對象、目前功能、補強中項目、安全原則、本地模型準備與驗收方式 |
| 開源發布前安全包 | 檢查清單可複製開源發布前安全包，確認本機設定/log 不提交、文件入口齊全、驗證指令與 Hermes 停手線都清楚 | 已驗證 | 2026-05-10 新增 `複製開源安全包`，並將 `.paperclip-dev-config.json`、`.paperclip-dev*.log`、`paperclip-dev*.log` 加入 `.gitignore` |
| 有開機預覽復原 SOP | 提供固定方式檢查與復原前後端預覽 | 已驗證 | 已新增 `docs/virtual-office-startup-sop.zh-TW.md` 與 `scripts/start-virtual-office-preview.ps1`；2026-04-29 已確認 `-CheckOnly` 只檢查不重啟，後端與前端皆 OK |
| 後端卡住時有診斷提示 | helper 失敗時列出殘留程序、embedded Postgres lock file 與安全復原建議 | 已驗證 | 2026-05-05 已用 `office:check` 等價的只檢查模式確認會顯示 `Backend recovery hints`、`postmaster.pid` 路徑、最後寫入時間與不要手動刪資料庫檔案的提醒 |
| 預覽狀態可留下報告 | helper 每次檢查後保存後端、前端、port、lock file 與下一步建議 | 已驗證 | 2026-05-07 `pnpm run office:check` 已產生 `.virtual-office-preview-status.json`，包含 `backendOk`、`frontendOk`、`portOwnership`、`embeddedPostgresLockFile` 與 `nextAction`；報告含本機路徑，已加入 `.gitignore` |
| dev config 不會造成 port 分裂 | `.paperclip-dev-config.json` 能同時被 migration-status 與後端主服務接受，避免 54331 / 54329 分裂 | 已驗證 | 2026-05-08 重開機後發現簡化 config 讓 migration-status 用 54331、server 退回 54329；已補成完整 config，`pnpm run office:restart` 後 Backend OK / Frontend OK，migration-status 回 `embedded-postgres@54331` |
| shared memory 卡住時有保守恢復流程 | 沒有 lock file、但 54331 顯示 unknown PID 且後端仍報 shared memory 時，文件明確要求不要刪資料庫並先重開 Windows | 已驗證 | 2026-05-08 後端啟動遇到 `pre-existing shared memory block is still in use`，`postmaster.pid` 不存在但 54331 仍顯示 unknown PID；已補進開機 SOP，作為重開機前後的固定判斷流程 |
| 瀏覽器安全阻擋時不強制操作 | 若 in-app browser 因 `data:` 錯誤頁拒絕操作，先做預覽重啟與只讀確認，不繞過安全限制修改資料 | 已驗證 | 2026-05-07 嘗試暫停 risk agents 時遇到瀏覽器安全阻擋；已改為 `office:restart`、`office:check` 與只讀 API 確認，未強制暫停員工 |
| 手動暫停不被舊工作覆蓋 | agent 被使用者暫停後，舊 queued/running run 不應把 agent 狀態改回 running | 已驗證 | 2026-05-07 實際處理 Eve 時發現 recovery run 會和暫停競態；已補強 heartbeat 啟動前重新讀取 agent 狀態，若已暫停或停用就取消舊 run |
| UI 有預覽服務狀態教學 | 新手操作檯與使用教學說明前端、後端 health、embedded Postgres lock file 的差異 | 已驗證 | 2026-05-05 已在 Office 主畫面加入 `預覽服務` 區塊與 `預覽服務故障判斷` 教學，提醒前端可開不代表後端資料可寫入 |
| 後端失敗時有友善頁 | App health 失敗時顯示復原指令、SOP 與不要刪資料庫檔案的提醒 | 已驗證 | 2026-05-05 已更新 `CloudAccessGate`，不再只顯示 `Failed to load health (500)`；新增單元測試確認會出現 `pnpm run office:check` 與 `postmaster.pid` |
| 後端復原頁有安全操作 | 復原頁提供重新檢查 health、複製狀態紀錄、手動選取摘要、三步驟復原順序、資料安全邊界、可貼給 Codex 的求助文字、關機/開機順序、恢復門檻與重要位置 | 已驗證 | 2026-05-05 已在 `CloudAccessGate` 新增 `重新檢查後端`、`複製狀態紀錄`、`可貼回紀錄的狀態摘要`、`先檢查 / 再重啟 / 還卡才重開機`、`現在可以做 / 先不要做`、`恢復後才繼續`、`重要位置`、`貼給 Codex 的求助文字`、`關機前 / 開機後`；單元測試確認重新檢查會再次呼叫 health，複製會寫入剪貼簿 |
| 復原頁可強制重載頁面 | 當前端 health 狀態卡在檢查中或代理短暫抖動時，可直接重新載入頁面 | 已驗證 | 2026-05-06 交接停用驗收時遇到前端 health 頁卡在 `檢查中...`，已新增 `重新載入頁面` 按鈕，讓新手不必手動處理瀏覽器狀態 |
| 開源前多次重開機實測紀錄 | 連續 2 到 3 次 Windows 重開後跑 `office:restart` 與 `office:verify`，確認預覽和後端能穩定恢復 | 已驗證 | 2026-05-15 已完成重開機驗收 3/3：三次重開後 `office:restart` 都成功補起 backend/frontend，`office:verify` 都通過，render smoke OK；已達開源前保守驗收門檻。 |
| 開源前一鍵新手啟動包 | 將啟動流程整理成更像雙擊或單一入口的方式，降低非工程使用者需要進 PowerShell 的機率 | 已驗證 | 2026-05-11 新增 `scripts/open-virtual-office.cmd`；雙擊後會回到 repo、優先使用本機 `.tools\pnpm.cmd`、執行 `pnpm run office:restart`，並明確顯示 heartbeat scheduler false、不喚醒 Hermes、預覽網址與失敗時可貼給 Codex 的輸出。 |
| 開源前長時間穩定性檢查 | 讓預覽與後端運行 1 到 2 小時不操作，確認後端、前端與 embedded Postgres 不掉線 | 已驗證 | 2026-05-12 已完成 60 分鐘長測：`.virtual-office-stability-report.json` 顯示 `status=pass`、60 samples、0 failed samples、heartbeat scheduler false；長測後 `pnpm run office:verify` 仍通過，render smoke OK。 |
| 長時間穩定性檢查工具 | 提供固定指令定時檢查 backend/frontend 並輸出可覆盤的穩定性報告 | 已驗證 | 2026-05-11 新增 `pnpm run office:stability` 與 `scripts/watch-virtual-office-preview.ps1`；2026-05-12 已完成 60 分鐘長測，2026-05-15 已完成 3/3 重開機驗收。 |
| 真實頁面渲染 smoke check | 除了 URL 2xx，也用乾淨瀏覽器實際載入 `/AI/office`，確認 React root 與 Office 文字已渲染 | 已驗證 | 2026-05-12 新增 `pnpm run office:render-smoke` 與 `scripts/check-virtual-office-render-smoke.mjs`；會啟動 headless Edge/Chrome，檢查頁面 title、root child count、body text 與 Virtual Office 關鍵字，並已接入 `office:verify`。 |
| 開源前新手啟動文件精簡版 | 將目前 SOP 壓成非工程使用者可快速照做的新手版，保留完整 SOP 作為疑難排解文件 | 已驗證 | 2026-05-11 新增 `docs/virtual-office-quick-start.zh-TW.md` 與英文版；短版只保留雙擊入口、失敗求助文字、Backend OK / Frontend OK / Heartbeat scheduler false 與先不要做的危險動作。 |

## 7. 每次開發後固定檢查

之後每次完成一段開發，至少做以下紀錄：

- 修改了哪些檔案。
- 新增或改動了哪些使用者可見功能。
- 哪些功能已在瀏覽器看過。
- 哪些按鈕只開表單，沒有送出。
- 是否跑過 `pnpm --filter @paperclipai/ui typecheck`。
- 哪些驗收項目從 `待開發` 變成 `部分完成` 或 `已驗證`。
- 哪些項目需要使用者親自判斷是否直覺。
| AI-98233 authToken-independent prompt proof 喚醒覆盤 | 單次 Sandbox/Test 喚醒安全完成並收尾；Hermes Sandbox Engineer 回到 paused/manual，`AI-98233` 已 done；失敗原因已進入後續 prompt routing 診斷與 final contract 修正。 | 已驗證 | 2026-05-11 run `a102f0c4-9d54-42cc-95ea-bcf3ea87a738`；comment `8d2f9aec-ea8d-45cf-83d4-eaa5dedb329b`；exact key proof 後續由 `AI-98530` 補上。 |
# 2026-05-12 AI-98523 acceptance ledger

| Item | Expected result | Status | Evidence |
| --- | --- | --- | --- |
| AI-98523 one-time authorization boundary | One wake only, only Hermes Sandbox Engineer, no Run now, no schedule trigger, no heartbeat scheduler, no formal project/data, no continuous wake | Verified | Authorization was used once; Hermes was paused after failure |
| Runtime skill prompt injection | Paperclip injects runtime skills into Hermes `taskBody` | Verified | Run log: `runtimeSkills=true`, `movedPromptTemplate=true`, `authToken=false`, `explicitApiKey=false` |
| Exact runtime skill keys proof | Hermes completion comment lists exact Paperclip runtime skill keys and marks `used` or `visible but not used` | Verified | AI-98523 failed before completion, but the proof was later completed by AI-98530 after bridge and prompt fixes |
| Recovery chain containment | Failed recovery issues do not create another recovery issue or liveness escalation child | Verified | Recovery service guard and targeted tests added on 2026-05-12 |
| Next retry gate | New Sandbox/Test issue plus new one-time authorization required before another Hermes wake | Verified | AI-98523 authorization is spent |
| AI-98526 retry issue prepared | Create next Sandbox/Test issue without waking Hermes | Verified | `AI-98526` created in `backlog`; new authorization required before wake |
| AI-98526 one-time wake boundary | One wake only, Hermes Sandbox Engineer only, stop after review | Verified | Run `00695265-e78f-4463-9450-53f12508de61`; Hermes paused after completion |
| AI-98526 exact runtime skill-key proof | Hermes lists exact Paperclip runtime skill keys in `Paperclip runtime skills` section | Verified | AI-98526 itself listed general Hermes-side skills, but that failure was reviewed and superseded by AI-98530 after prompt wording and final contract ordering fixes |
| Hermes runtime skill prompt ordering | Runtime skills exact-key requirement appears after moved Hermes agent instructions | Verified | Adapter ordering changed and covered by `adapter-registry.test.ts` |
| AI-98527 one-time wake boundary | One wake only, Hermes Sandbox Engineer only, stop after review | Verified | Run `52361152-f7d7-4acf-b0df-6eff4b933133`; Hermes paused after completion |
| AI-98527 exact runtime skill-key proof after ordering fix | Hermes lists exact Paperclip runtime skill keys in `Paperclip runtime skills` section | Verified | AI-98527 itself listed Hermes-side skills, but that failure was reviewed and superseded by AI-98530 after diagnostic logging, wording, and final contract ordering fixes |
| Hermes CLI/context diagnosis gate | Stop repeat proof issues until Hermes CLI/context handling is inspected | Verified | Diagnosis found Paperclip injection/order/model route were green; final blocker was strict output-format ordering |
| AI-98530 final output contract proof | Hermes lists exact Paperclip runtime capability keys and marks each key used or visible but not used | Verified | Run `76a100e8-9e24-4acc-add4-515cde557494`; session `20260512_184726_cadfe1`; all 7 exact keys returned; Hermes paused/manual; active run null; company live runs 0 |
