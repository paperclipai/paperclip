# 發布運行編排計劃

## 上下文

我們觀察到單一問題（例如 PAP-39）的級聯喚醒同時產生多個運行：

- 受讓人從`issue_commented`自我喚醒
- 從 `issue_comment_mentioned` 向經理/CTO 提及喚醒
- 對同一問題的重疊運行

目前的行為是以運作為中心和以智能體為中心的。它合併 `heartbeat.wakeup` 中的每個智能體程式+任務，但不會在所有智能體之間強制每個問題使用單一活動執行槽。

## 我們今天所知道的

- 今天唯一可靠的問題/運行連結來自運行狀態為 `queued` 或 `running` 的 `heartbeat_runs.context_snapshot.issueId`。
- `checkoutRunId` 的問題是工作所有權鎖，而不是編排鎖。
- 喚醒是從多個路由（`issues`、`approvals`、`agents`）和透過 `heartbeat.wakeup` 的所有漏斗創建的。

## 目標

1. 當目標智能體程式與目前活動的問題執行程式具有相同的規範化名稱時，防止相同問題的自喚醒級聯。
2. 允許跨智能體程式喚醒請求，但在當前問題執行程式退出之前不要執行它們。
3. 保證每個問題一次最多有一個活動（排隊或運行）執行所有者。
4. 將這種強制執行集中在編排中（而不是提示/技能規則）。

## 非目標

- 替換程式碼更改所有權的簽出語意。
- 更改經理升級政策本身。
- 在全球範圍內強制執行智能體名稱的唯一性（作為單獨的治理決策處理）。

## 建議模型

在 `issues` 上使用顯式問題級編排鎖。

### 新發行的房產

- `executionRunId: uuid | null`（FK 至 `heartbeat_runs.id`、`ON DELETE SET NULL`）
- `executionAgentNameKey: text | null`（規範小寫/修剪的智能體名稱）
- `executionLockedAt: timestamptz | null`

`executionRunId` 是規範的「誰目前擁有此問題的編排」欄位。

## 編排規則

### 規則 A：禁止使用相同智能體名稱進行自我喚醒

如果喚醒是問題範圍的，並且 `issues.executionRunId` 指向 `executionAgentNameKey` 與喚醒智能體名稱鍵匹配的活動運行：

- 不建立新的心跳運行
- 將喚醒請求寫入 `coalesced`，原因為 `issue_execution_same_name`
- 返回現有的運行參考

### 規則 B：不同的名字可能會醒來，但會等待

如果問題具有由不同智能體名稱金鑰持有的活動執行鎖定：

- 接受喚醒請求
- 將請求保留為延遲（新的喚醒狀態 `deferred_issue_execution`）
- 尚未建立運行

當活動問題運行完成時，將該問題的最早的延遲請求提升到排隊運行並傳輸 `executionRunId`。

### 規則 C：每個問題都有一個活躍執行所有者

對於問題範圍的喚醒，只有在持有問題行上的交易鎖定時才能建立運作。這確保一次只有一個排隊/正在運行的運行可以成為所有者。

## 實施計劃

## 第一階段：架構 + 共享合約1.新增問題欄：`execution_run_id`、`execution_agent_name_key`、`execution_locked_at`。
2. 在`packages/shared/src/types/issue.ts`中擴充共享的`Issue`型式。
3. 新增遷移和導出更新。

## 第 2 階段：將問題執行閘集中在 `heartbeat.wakeup`

1. 在`enqueueWakeup`中，像今天一樣從上下文/有效負載中派生`issueId`。
2. 如果沒有`issueId`，則保留現有行為。
3. 如果`issueId`存在：
   - 問題行上的交易 + `SELECT ... FOR UPDATE`
   - 解決/修復過時的`executionRunId`（如果引用的運行不是`queued|running`，則清除鎖定）
   - 應用規則 A/規則 B/規則 C
4. 名稱規範化助手：
   - `agentNameKey = agent.name.trim().toLowerCase()`

## 第 3 階段：運行完成時的延遲佇列提升

1. 運行時終端狀態（`succeeded`、`failed`、`cancelled`、孤兒收穫）：
   - 如果運行擁有`issues.executionRunId`，則清除問題鎖定
   - 將最早的延遲問題喚醒提升到排隊運行
   - 將問題鎖定到升級的運行
   - 觸發`startNextQueuedRunForAgent(promotedAgentId)`

## 第 4 階段：路線衛生（「無所不在」）

1. 透過智能體 ID 保持路由端喚醒重複資料刪除，但依賴心跳門作為事實來源。
2. 確保所有與問題相關的喚醒呼叫在負載/上下文快照中包含 `issueId`。
3. 增加明確的原因代碼，以便日誌使抑制/延遲變得明顯。

## 第 5 階段：測試

1. `heartbeat.wakeup` 的單元測試：
   - 同名自我喚醒被抑制
   - 不同名稱喚醒延遲
   - 所有者完成時釋放鎖定並提升延遲喚醒
   - 過時的鎖恢復
2. 整合測試：
   - 在活動受讓人運行期間使用 `@CTO` 進行評論不會建立並發活動運行
   - 任何時候每個問題只有一位活躍所有者
3. 回歸測試：
   - 非問題喚醒不變
   - 對於沒有問題情境的任務，現有的分配/計時器行為不變

## 遙測+可調試性

- 在`agent_wakeup_requests.reason`中加入結構化原因：
  - `issue_execution_same_name`
  - `issue_execution_deferred`
  - `issue_execution_promoted`
- 新增鎖定傳輸事件的活動日誌詳細資訊：
  - 從運行 ID / 到運行 ID / 問題 ID / 智能體名稱鍵

## 推出策略

1. 船舶模式+功能標誌（`ISSUE_EXECUTION_LOCK_ENABLED`）預設為關閉。
2. 在開發中啟用並驗證 PAP-39 樣式場景。
3. 在暫存中啟用高日誌詳細程度。
4. 穩定運轉後預設開啟。

## 驗收標準

1. 單一問題永遠不會有多個活動執行擁有者同時運作 (`queued|running`)。
2. 同一問題的同名自喚醒被抑制，而不是產生。
3. 接受不同名稱的喚醒，但會延後到釋放執行鎖定為止。
4. 在活動問題運行期間提及 CTO 不會同時針對該問題啟動 CTO。
5. 透過單獨的問題/子問題仍然可以實現並行性。

## 後續行動（單獨但相關）簽出衝突邏輯應獨立修正，以便具有 `checkoutRunId = null` 的受讓人可以透過目前運行 ID 取得簽出，而不會出現錯誤 409 迴圈。