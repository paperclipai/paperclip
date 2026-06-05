# Virtual Office Routine / 排程安全說明

這份文件給第一次使用 Virtual Office 的人看。Routine 可以讓 AI 員工定期整理進度、提醒阻塞、產生覆盤紀錄，但它也可能在你沒有注意時自動建立工作或喚醒 agent，所以第一版先用保守方式設計。

## 目前可以放心做的事

- 在 Office 主畫面查看 Routine / schedule 安全面板。
- 複製排程啟用前檢查表，貼到自己的筆記或 issue 裡逐項確認。
- 預填 Sandbox routine 草稿，先看標題與描述是否符合目的。
- 打開既有 Routines 頁查看排程狀態與最近執行紀錄。
- 在 Sandbox/Test 專案裡手動測一次，而且執行前要勾選安全確認。

## 目前不會自動做的事

- 不會從 Office 主畫面直接建立 routine。
- 不會自動新增 cron、webhook 或 API trigger。
- 不會自動按 Run now。
- 不會自動指派 Hermes 或其它本地模型員工。
- 不會打開 heartbeat scheduler。

## 建立草稿前

先確認 routine 名稱或描述含有 Sandbox、Test 或 Virtual Office。這能讓 UI 辨識它是安全測試用 routine，並在新增 trigger 或手動執行時顯示安全門。

建議第一個 routine 只做「整理現況」這類低風險任務，例如：

- 每日進度整理
- 每週覆盤會議
- 阻塞提醒

不要一開始就讓 routine 修改正式資料、建立正式任務，或喚醒正式員工。

## 新增 trigger 前

新增 trigger 代表 routine 可能在未來自動被觸發。請先確認：

- 專案是 Sandbox/Test。
- 指派員工不是正式工作中的員工。
- trigger 頻率不會太密集。
- 描述裡有明確停止條件。
- 你知道要去哪裡停用或刪除 trigger。

Virtual Office routine 詳情頁會要求先勾選 Sandbox/Test 安全確認，才允許新增 trigger。

## 手動 Run now 前

Run now 會立刻建立一次 routine 執行。請先確認：

- 這次只用測試資料。
- 不會寫入 API key、token、密碼或私人資料。
- 任務描述有要求 agent 先回報理解，不要直接修改檔案或正式任務。
- 你知道完成後要看最近執行紀錄與相關 issue。

Routines 清單與 Routine 詳情頁都會在 Virtual Office routine 執行前顯示安全確認。

## 測完後

測完請留下覆盤紀錄，至少包含：

- routine 名稱
- trigger 類型
- 指派員工
- 是否有建立 issue
- 是否有 recovery issue
- 是否需要使用者介入
- 下一步：保留、調整、停用或刪除

## 什麼時候可以進到 Hermes

等以下條件都穩定後，再開始安排 Hermes 或其它本地模型接 routine：

- 預覽後端與前端都健康。
- Sandbox/Test 專案可正常建立與覆盤。
- Routine trigger 與 Run now 安全門都通過驗收。
- Hermes WSL bridge、模型名稱與 API key 狀態都已確認。
- 第一次喚醒仍只接 Sandbox/Test issue。

目前 Virtual Office 的原則是：先讓新手看懂、能檢查、能停下來，再進入自動化。
