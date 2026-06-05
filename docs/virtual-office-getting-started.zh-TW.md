# Virtual Office 新手入門

Virtual Office 是建立在 Paperclip 之上的 2.5D 新手操作台，目標是讓本地模型與 agent 新手可以用比較直覺的方式管理：

- AI 員工
- 公司技能
- 專案
- 工作流
- 會議討論與覆盤紀錄

這不是商業 SaaS 入口，而是偏向個人團隊、個人公司、研究與本地模型練習的開源工具介面。

## 最短啟動方式

如果你只想先把畫面打開，請看 `docs/virtual-office-quick-start.zh-TW.md`，或直接雙擊：

```text
scripts/open-virtual-office.cmd
```

這個入口只做安全啟動與預覽復原，會保持 heartbeat scheduler 關閉，不會喚醒 Hermes。

## 建議使用流程

1. 建立公司

   先完成 Paperclip 的公司 onboarding。Virtual Office 會跟著目前選取的公司顯示資料。

2. 建立員工

   在 `Virtual Office` 頁面點 `建立員工`。建議先建立幾種角色：

   - 專案管理或 PM
   - 工程或自動化
   - 需求或產品
   - 測試或覆盤

3. 建立 starter skills

   點 `安裝技能`，在技能安裝精靈中可以先建立常用 starter skills：

   - 會議紀錄與覆盤
   - 需求分析
   - 測試檢查

   建立後可勾選並同步給目前選擇的員工。

4. 建立專案工作流

   點 `建立工作流`，填寫專案名稱與說明，選擇：

   - 專案主管
   - 上下游順序或平行單位協作
   - 各階段負責員工

   送出後會建立一個 Paperclip project，並產生五個階段任務：

   - 需求整理
   - 方案設計
   - 實作處理
   - 測試檢查
   - 覆盤紀錄

5. 開討論任務

   需要員工討論時，點 `開討論任務`。可以指定：

   - 會議主題
   - 議程
   - 關聯專案
   - 主持人
   - 參與員工

   建立後會變成一個 Paperclip issue，用來保存討論過程、決策理由、待確認問題與下一步。

## 預覽與安全

部分按鈕會修改本地 Paperclip 資料：

- 建立工作流
- 建立會議任務
- 建立 starter skill
- 同步技能
- 建立 routine
- 新增 routine trigger
- 手動 Run now

如果只是試看介面，可以打開表單但不要按最後的建立或同步按鈕。

## Routine / 排程安全

Routine 可以讓 AI 員工定期整理進度、提醒阻塞、產生覆盤紀錄，但也可能在未來自動建立工作或喚醒 agent。第一次使用請先照這個順序：

1. 先做草稿：只預填 Sandbox/Test routine。
2. 再過安全門：新增 trigger 或 Run now 前，先確認專案、員工與目的。
3. 最後覆盤：測完查看 runs、active issues、recovery issues，再決定保留、調整、停用或刪除。

Office 不會自動建立 routine、不會自動新增 trigger、不會自動 Run now、不會自動指派 Hermes，也不會打開 heartbeat。詳細說明在：

```text
docs/virtual-office-routine-safety.zh-TW.md
```

## 端到端驗收沙盒

等到要真正驗收會修改資料的功能時，建議先限制在測試資料裡：

1. 建立一位測試員工，例如 `Test PM` 或 `Sandbox Engineer`。
2. 建立一個測試專案，例如 `Virtual Office Sandbox`，不要選正式專案。
3. 先複製 Markdown 檢查清單，記下要驗收的項目、預期結果與實際結果。
4. 一次只驗收一種會改資料的動作，例如先同步技能，再測建立工作流。
5. 驗收後把結果補回檢查清單或進度紀錄，避免之後重複猜測。

如果只是要交接「還差什麼才能完成理想版」，可以在 Office 的 `檢查清單` 裡按 `複製剩餘路線`。它只會複製技能 runtime 載入、文件人工閱讀與 Hermes 沙盒喚醒三個 gate，不會帶出整份大清單。

## 第一個成功沙盒任務範例

`AI-98533` 是一個可以給新手參考的 Sandbox/Test 成功案例：使用者先建立「晨間財經新聞 AI 團隊」方案設計任務，再改派 Eve。這些動作都只是編輯，不會自動喚醒模型。

真正喚醒前，需要先確認沒有 active run、沒有 live runs、沒有 recovery chain，然後由使用者貼出逐字一次性授權。這次授權只允許 Eve / Hermes local 讀取 `AI-98533` 並回覆一則方案設計 comment；不允許 Run now、schedule trigger、heartbeat scheduler、連續喚醒、讀取密鑰、處理正式資料或真實投資建議。

實測結果是 Eve 成功留下方案設計 comment，完成後又回到 `paused/manual`，`AI-98533` 回到 `backlog`，active/live runs 都是 0，且使用者人工確認 `內容方向 OK`。

主畫面的端到端驗收沙盒區可以按 `複製成功範例`，取得這個流程的 Markdown 版本。這份範例不是新的喚醒授權；如果要讓任何員工再跑一次，仍然要重新給新的逐字一次性授權。

如果準備開源或交付給別人試用，請先按 `複製交付判斷`。它會把目前狀態分成可交付、仍需證據與不可越線三類，提醒可開源試用不等於 Hermes 真喚醒、skills runtime loading 或真人文件試讀都已完成。

發布前請再按 `複製開源安全包`，確認本機設定與 log 不會被提交、文件入口齊全、`pnpm run office:verify` 可用，且 Hermes 安裝、憑證、Run now、排程與喚醒仍在停手線內。

若要做最後開源發布核對，請看 `docs/virtual-office-release-checklist.zh-TW.md`。它會逐項檢查 README、issue form、PR template、CONTRIBUTING、SECURITY、驗收文件、本機檔案與 Hermes 停手線。

如果要交接給下一位協作者，請按 `複製 Gate 交接`。它會列出最後 gate 的完成條件與不可越線動作，提醒不要把 skills UI 同步當成 runtime 已驗證、不要把文件工具當成人工閱讀已完成，也不要在未授權前安裝或喚醒 Hermes。

如果只是每天開工前想知道「今天能做什麼」，請按 `複製 Gate 決策`。它會把最後三個 gate 分成今天可安全做、先暫緩、授權後才做，特別標出 Hermes 安裝、Run now 與 schedule trigger 的停手線。

如果準備接近 Hermes 安裝線，但還不想一次授權全部動作，請在 Hermes 區塊按 `複製授權階梯`。它會把只讀準備、命令預覽、安裝陪同、設定檢查與沙盒喚醒分成第 0 到第 4 階；沒有明確說第幾階時，只停在只讀準備。

如果只是想知道目前停在哪一階，請按 `複製授權總控`。它會把第 0 到第 4 階、喚醒後覆盤與下一個最小安全動作整理成一份狀態卡；這不是安裝、憑證、Run now、排程或喚醒授權。

若只是想進入第 1 階，請按 `複製命令表單`，再貼給 Codex。這份表單只允許 Codex 列命令表，不允許執行；任何會寫檔、下載、改設定、碰憑證、Run now、schedule trigger 或喚醒模型的項目都要標成 PAUSE。

若第 1 階命令表已經看懂，準備讓 Codex 執行其中一條，請先按 `複製逐條同意`。這份紀錄要求每條命令單獨同意、單獨回報結果；不能用一句同意涵蓋全部命令。

若 Hermes 已在自己的設定位置填好 provider / model / API key，請按 `複製設定檢查`。這是第 3 階，只回報非敏感設定狀態與 Test environment 摘要；不要貼 API key、token、密碼、完整 `.env` 或含憑證的 log，也不要把這一步當成喚醒授權。

若第 3 階通過、準備進入第一次 Sandbox/Test 喚醒，請先按 `複製喚醒前檢查`。這是第 4 階前置確認，只確認環境、Sandbox 員工、Sandbox/Test 專案與使用者確認；Office 只可預填 issue 草稿，不自動建立、不 Run now、不啟用排程。

若未來真的完成第一次 Sandbox/Test 喚醒，請先按 `複製喚醒後覆盤`。它會整理 Hermes 回覆是否可讀、員工是否卡住、live runs / recovery 是否乾淨，以及是否可以繼續下一個 Sandbox/Test 任務；不乾淨時先停下，不進正式專案。

建議每次都用同一個紀錄格式：

```text
- 日期：
- 驗收項目：
- 測試資料：
- 操作步驟：
- 預期結果：
- 實際結果：
- 結論：通過 / 需修正 / 暫緩
- 補充截圖或連結：
```

建議驗收批次：

1. 沙盒與備份：只確認測試員工、測試專案與 Markdown 紀錄，不按會改資料的按鈕。通過標準是能說清楚本次測試範圍與紀錄位置。
2. 技能與 starter skills：驗收 starter skill 建立、已存在偵測、技能勾選與同步。通過標準是同步後測試員工能力正確，重新整理後仍保留，且沒有重複 starter skill。
3. 員工改名與停用：驗收保存、未保存提醒、交接建議、二次確認與停用後歷史紀錄保留。通過標準是保存後資料正確、停用前有交接確認、正式紀錄沒有被刪除。
4. 專案工作流：驗收五階段專案、任務、主管、負責人與上下游說明。通過標準是五個階段任務產生正確，工作流地圖能看出上下游或平行關係。
5. 會議與覆盤：驗收會議任務、參與者、介入規則與可覆盤討論欄位。通過標準是 issue 內有議程、參與者、介入規則、決策理由、待確認問題與下一步。

如果某批未通過，先不要重複按建立、同步、保存、停用，也不要要求 agent 繼續討論。請先把以下資訊記下來：

- 當時驗收批次與操作步驟。
- 已經產生或修改了哪些測試資料。
- 畫面錯誤訊息或重新整理後狀態。
- 是否需要先清理測試資料，再重新驗收。

清理測試資料前，先確認：

- 資料名稱有測試標記，例如 `Test`、`Sandbox` 或 `Virtual Office Sandbox`。
- 已記下測試員工、測試專案、測試 issue 或 starter skill 的連結與名稱。
- 沒有正式任務、正式專案主管或仍需保留的討論紀錄綁在測試資料上。
- 驗收紀錄已補完，再決定要清理或保留當作範例資料。
- 若不確定是否能刪除，先停下來詢問，不要直接清理。

正式驗收前，建議先記錄一份快照：

- 目前員工清單與每位測試員工的名稱、職稱、能力摘要。
- 技能庫中已存在的 starter skills 與準備數。
- 測試專案名稱、目前任務數與工作流預覽中的五個階段。
- 測試會議或覆盤 issue 的數量與是否需要使用者介入。
- 預覽服務網址、後端健康狀態，以及是否仍顯示 restart required。

會寫入本地資料的按鈕包含：

- `建立 starter skill`：會在技能庫建立新的公司技能。先按預覽並確認沒有同名 skill。
- `同步技能`：會把勾選的 skills 寫入指定員工設定。先確認員工與勾選清單。
- `保存員工變更`：會更新員工名稱、職稱或能力描述。先確認未保存提示與範本套用結果。
- `停用員工`：會把員工移出目前辦公室顯示。先看影響提示、交接建議與二次確認。
- `建立工作流`：會建立 Paperclip project 與五個階段任務。先看工作流預覽。
- `建立會議任務`：會建立 Paperclip issue。先確認議程、參與者、模板與介入規則。

開始端到端驗收前，確認五個門檻都已準備：

- 快照已記錄。
- 測試資料已限定。
- 批次順序已確認。
- 資料變更按鈕已辨識。
- 失敗與清理規則已確認。

## 本地模型準備檢查

Hermes、Ollama、vLLM、LM Studio 或其它本地模型要真正接手任務前，建議先完成這些檢查：

1. 本地模型服務已啟動，且可從 Paperclip 所在機器連到正確網址。
2. Paperclip 員工的 adapter 已設定到正確模型、端點與角色。
3. 先用小型測試任務確認 agent 能讀任務、回覆紀錄，並留下可覆盤內容。
4. 觀察是否出現大量 recovery issues；若有，先修設定，不要急著打開自動喚醒。
5. 確認穩定後再開啟 heartbeat 或其它自動排程。

目前 Virtual Office 先把這些檢查放在新手教學中，目標是讓使用者知道「還差哪一步」，而不是一開始就自動啟動模型。

若要接 Hermes，請先照 `docs/virtual-office-hermes-sop.zh-TW.md` 走完預檢。重點順序是：先確認 Paperclip 預覽健康，再確認 Windows 上的 WSL2/Ubuntu、`hermes` CLI 橋接、模型憑證與沙盒邊界，接著建立 Hermes 沙盒員工，通過環境測試後才做第一個沙盒喚醒。Office 主畫面的 `Hermes / local model gate` 也會顯示同一組安裝前確認，安裝或橋接後可按 `重新檢查`。

如果要驗證 skills 是否真的在執行時被本地模型載入，請在 Office 的 `檢查清單` 裡按 `複製技能載入驗收`。這份模板會要求只用 Sandbox/Test issue，並記錄 adapter 是否支援 runtime skill loading、agent 回覆中是否看得出指定 skill 被使用。

Hermes 區塊也有 `技能載入驗收準備度`。先看 `Adapter skills`、`Starter skills`、`Sandbox/Test` 與 `下一步` 四格；它只做只讀判斷，條件未齊前不要建立 issue 或喚醒模型。

若只是要交接目前技能同步狀態，請在 Hermes 區塊按 `複製技能交接`。它會把 starter skills、Hermes Sandbox 員工、Sandbox/Test 專案與 runtime readiness 整理成 Markdown，並提醒：`desired skills 已保存` 不等於 `runtime skill loading 已驗證`。這份交接不會建立 issue、不會 Run now，也不會喚醒 Hermes。

若要驗證技能精靈本身的 UI 與資料同步，請在檢查清單按 `複製技能同步 E2E`。這張任務卡只用 Sandbox/Test 員工驗證「選員工、勾 skills、同步、重新整理後仍保留」，不代表本地模型已在 runtime 使用技能。

若只想安全確認前一次技能同步是否仍保存，請按 `複製技能同步復查`。它只讀取 `Sandbox Skills Sync Test` 的 desired skills，列出 3 個 starter skills 是否保存，不會按同步、不會建立 issue、不會 Run now，也不會喚醒 Hermes。

若準備邀請朋友或 GitHub 讀者幫忙看文件，請在檢查清單按 `複製開源試讀邀請`。它會產生一段白話邀請，說明試讀目標、閱讀範圍、不要做的高風險操作，以及回覆格式。

如果對方真的打開預覽試用，請改用 `複製試用回報`。它會收集作業系統、Office 是否打開、Backend/Frontend 狀態、卡住步驟與錯誤摘要，但提醒不要貼 API key、完整 `.env`、完整 log 或私密路徑。

若未來要把回報整理成 GitHub issue，請按 `複製 issue 回報`。它會把啟動卡住、畫面文字、文件、Hermes 前置與安全疑慮分流，並要求只貼短錯誤摘要，不貼密鑰、完整 log、私密路徑或正式資料。

開源後也可以直接使用 `.github/ISSUE_TEMPLATE/virtual-office.yml` 建立 GitHub issue；它會用欄位化表單收集同樣資訊，並要求先確認沒有貼敏感資料。

若要貢獻文件或修正，請先看 `CONTRIBUTING.md` 的 Virtual Office feedback 段落；若回報可能包含安全漏洞或敏感資訊，請照 `SECURITY.md`，不要開公開 issue。

若要送 Virtual Office 相關 PR，請看 `.github/PULL_REQUEST_TEMPLATE.md` 裡的 Virtual Office verification block。它會提醒跑 `pnpm run office:verify`、人工檢查頁面或文件、同步驗收清單，並確認沒有安裝 Hermes、Run now、啟用排程或喚醒模型。

收到試讀回覆後，請按 `複製回饋彙整`。它會把意見分成必修、建議修、可延後與安全風險，方便之後轉成文件修正或 UI 待辦。

整理完回饋後，請再按 `複製回填卡`。它會提醒：試讀邀請不等於文件已通過；需要把讀者意見回填成要改的文件、UI 文字、安全提醒，以及是否能更新檢查清單裡的 `部分完成` 狀態。

若要逐位保留證據，請按 `複製證據紀錄`。它會記錄試讀者背景、閱讀範圍、是否知道第一步與安全停手線、卡住原話，以及文件 gate 是否能從 `部分完成` 往前推進。

若要請英文讀者協助，請按 `複製英文試讀包`。它會指定英文 getting started、英文開源導覽與英文 Routine safety，並請讀者檢查英文語氣、中文 UI 對照與安全提醒是否清楚。

若要判斷英文文件 gate 能不能往完成推進，請按 `複製英文完成判斷`。它會把自動可讀性檢查與英文讀者人工回饋拆開，避免把「英文檔案沒有亂碼」誤認為「英文新手真的看懂」。

建立 Hermes Sandbox 員工前，請先按 `複製草稿確認包`，核對新員工頁將帶入的 adapter、command、starter skills 與安全 prompt。建立完成回到 Office 後，再按 `複製建立後回報`，把 Sandbox 員工、skills 同步、正式主管與環境測試狀態整理給 Codex 或驗收紀錄。這兩份內容都只是交接文字，不會建立任務、Run now 或喚醒 Hermes。

## 驗收檢查

開發過程會同步維護：

```text
docs/virtual-office-acceptance-checklist.zh-TW.md
```

這份檢查表用來確認每個功能是否符合原本設計，包含新手操作、員工與技能、專案工作流、會議覆盤、本地模型與開源教學。
每次新增功能後，會記錄目前狀態是 `已驗證`、`部分完成`、`待開發` 或 `需人工驗收`。

如果你照文件操作時卡住，請在 Office 的 `檢查清單` 裡按 `複製文件回饋`。這會產生固定格式，方便回報讀到哪份文件、哪一步卡住、哪些句子太工程化，以及安全提醒是否清楚。

如果你要請另一位新手試讀文件，可以先按 `複製閱讀準備`。它會把第一次啟動、開源試用與 Hermes 前再讀的文件拆成三組，並附上每組要檢查的問題。

如果試讀者不會程式，請改按 `複製新手自評`。它只問三件事：能不能照做、哪裡卡住、安全停手線是否清楚。回報時不需要貼 API key、token、密碼或完整 `.env`，也不需要建立任務、Run now 或喚醒 Hermes。

若要判斷中文文件 gate 能不能往完成推進，請按 `複製中文完成判斷`。它會把文件工具與模板已準備、以及仍需非工程新手實際試讀的部分拆開，避免把「有文件」誤認為「新手真的看懂」。

如果你只是想請朋友或未來開源使用者快速試讀一次，請按 `複製真人試讀任務`。它會產生 30 到 45 分鐘的任務卡，列出要讀哪幾份文件、可以做什麼、不能做什麼，以及最後要怎麼回報卡住位置。

如果你要判斷技能精靈到底算不算完成，請按 `複製技能完成判斷`。它會把「UI/資料同步已通過」和「runtime skill loading 尚未驗證」拆開，避免把 desired skills 已保存誤認為模型執行時已真的載入 skills。

## 本地預覽

開發預覽建議先關閉 heartbeat scheduler，避免尚未設定好的本地 agent 自動執行：

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

## 每日開工前安全檢查

每天第一次打開 Virtual Office，建議先照這個順序：

1. 跑 `pnpm run office:check`，確認 Backend OK 與 Frontend OK。
2. 打開 `http://localhost:5173/AI/office`。
3. 先看新手操作檯與預覽服務狀態。
4. 確認 heartbeat 仍是關閉狀態。
5. 確認沒有意外的 running/error 員工或 recovery issues。
6. 需要動到 routine、Hermes、員工停用或正式資料前，先複製對應檢查表。

如果 `office:check` 不通過，先不要建立工作流、同步 skills、保存員工、Run now 或喚醒 Hermes。請先照 `docs/virtual-office-startup-sop.zh-TW.md` 復原預覽。

Office 新手操作檯的 `預覽服務` 區塊也有 `複製開機安全包`。如果重開機後仍卡住，可以先按這個按鈕，把每日開工檢查、預覽求助文字、狀態報告覆盤模板與預覽故障決策表一起貼給 Codex。

如果 `office:verify` 或 `office:check` 顯示 Backend OK 但 Frontend blocked，先照 `docs/virtual-office-startup-sop.zh-TW.md` 的「前端 blocked 但後端 OK 時」處理。這種情況通常只需要重啟預覽服務，不代表資料庫壞掉，也不需要喚醒 Hermes。

如果已經設定好預覽輔助腳本，也可以使用：

```powershell
pnpm run office:check
pnpm run office:start
pnpm run office:restart
```

如果要一次檢查 UI 型別、驗收清單、文件連結與預覽健康，可以跑：

```powershell
pnpm run office:verify
```

## 文件地圖

新手可以依照目的打開文件：

- `docs/virtual-office-getting-started.zh-TW.md`：中文新手入門。
- `docs/virtual-office-getting-started.en.md`：英文新手入門。
- `docs/virtual-office-quick-start.zh-TW.md`：中文最短啟動版。
- `docs/virtual-office-quick-start.en.md`：英文最短啟動版。
- `docs/virtual-office-open-source-readme.zh-TW.md`：中文開源導覽。
- `docs/virtual-office-open-source-readme.en.md`：英文開源導覽。
- `docs/virtual-office-acceptance-checklist.zh-TW.md`：功能驗收與設計符合度紀錄。
- `docs/virtual-office-startup-sop.zh-TW.md`：開機後預覽或後端卡住時的復原流程。
- `docs/virtual-office-hermes-sop.zh-TW.md`：Hermes 本地模型安裝、環境測試與沙盒喚醒流程。
- `docs/virtual-office-routine-safety.zh-TW.md`：中文 Routine / schedule 排程安全說明。
- `docs/virtual-office-routine-safety.en.md`：英文 Routine / schedule safety notes。

## 貼給 Codex 的求助文字

如果你不會程式，可以直接複製下面其中一句貼給 Codex：

```text
請依照 docs/virtual-office-startup-sop.zh-TW.md 幫我檢查 Virtual Office 預覽，先只做健康檢查，不要刪資料庫，不要建立或修改資料。
```

```text
請依照 docs/virtual-office-acceptance-checklist.zh-TW.md 幫我檢查目前 Virtual Office 功能進度，整理哪些已驗證、哪些還不能碰正式資料。
```

```text
請依照 docs/virtual-office-routine-safety.zh-TW.md 幫我檢查 Routine / schedule 設定，先確認 Sandbox/Test、安全門與覆盤紀錄，不要新增 trigger，不要 Run now，不要指派 Hermes。
```

```text
請依照 docs/virtual-office-hermes-sop.zh-TW.md 幫我檢查 Hermes 設定狀態，只做環境與安全門檻檢查，不要喚醒 agent，不要寫入 API key 或密碼。
```

## 給貢獻者

這個介面的設計原則：

- 優先讓新手知道下一步該做什麼
- 避免要求使用者先理解 Paperclip 的完整內部模型
- 操作要能回到 Paperclip 原生資料結構
- 對會修改資料的動作保持明確提示
- 保留討論與決策過程，方便人類覆盤
