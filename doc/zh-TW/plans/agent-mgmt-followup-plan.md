# Agent管理後續計劃（CEO補丁+配置回溯+Issue↔審批連結）

狀態： 擬定
日期：2026-02-19
上下文：運行 `faeab00e-7857-4acc-b2b2-86f6d078adb4` 的後續操作

## 1. 調查結果

## 1.1 為什麼CEO PATCH失敗

根本原因是明確路由邏輯：

- `server/src/routes/agents.ts` 目前阻止任何智能體修補另一個智能體程式：
  - `if (req.actor.type === "agent" && req.actor.agentId !== id) { ... "Agent can only modify itself" }`

因此，即使執行長擁有僱傭許可，該路線仍然強制執行舊的僅自我補丁行為。

## 1.2 為什麼評論品質感覺不對

- `skills/paperclip/SKILL.md` 和 `skills/paperclip/references/api-reference.md` 目前不要求狀態評論（連結、結構、可讀更新）的 Markdown 格式品質。
- 因此，智能體會使用原始 ID 產生簡單的散文評論，而不是連結的實體。

## 1.3 問題↔審批連結差距

- 目前，發布和批准之間沒有直接的資料庫關係。
- 批准有效負載可能包括上下文 ID，但這不是規範連結。
- 如果沒有手動複製貼上 ID，UI 頁面無法可靠地交叉連結問題/批准。

## 1.4 配置回滾間隙

- 智能體程式配置更新目前覆蓋狀態，沒有專用的修訂歷史記錄表。
- 有活動日誌記錄，但沒有一流的設定版本分類帳或回滾端點。

## 2. 產品/行為變更

## 2.1 允許CEO給其他同公司智能體打補丁

目標行為：

- 董事會：完整的補丁權。
- CEO：可以修補同一家公司的智能體。
- 其他智能體：除非明確授予未來許可，否則只能自行修補。

注意：

- 嚴格公司邊界檢查。
- 單獨管理特權領域。

## 2.2 新增一級智能體程式設定修改日誌+回滾

每個影響配置的突變都必須建立一個修訂記錄：

- 快照之前
- 快照後
- 演員資訊（使用者/智能體）
- 可選原因/評論
- 來源運行 ID（如果可用）

回滾必須是一個 API 調用，以原子方式恢復先前的修訂。

## 2.3 在技能中強制執行 markdown 和問題評論鏈接

技能指導應要求：

- 短降價結構（`Summary`、`Actions`、`Next`）
- 相關時建立/更新實體的鏈接
- 避免沒有連結的原始 ID

## 2.4 增加明確的Issue↔Approval連動（多對多）

實施規範連接模型，以便一個問題可以連結多個批准，一個批准可以連結多個問題。

## 3. 資料模型規劃

## 3.1 新表：`agent_config_revisions`

欄位：

- `id` uuid pk
- `company_id` uuid fk
- `agent_id` uuid fk
- `revision_number` int（每個智能體程式單調）
- `reason` 文字為空
- `changed_by_agent_id` uuid 空
- `changed_by_user_id` 文字為空
- `run_id` uuid 空
- `before_snapshot` jsonb 不為空
- `after_snapshot` jsonb 不為空
- 時間戳

索引：

- `(company_id, agent_id, revision_number desc)`
- `(agent_id, created_at desc)`

## 3.2 新表：`issue_approvals`

欄位：- `id` uuid pk
- `company_id` uuid fk
- `issue_id` uuid fk
- `approval_id` uuid fk
- `relationship` 文字預設`context`
- `linked_by_agent_id` uuid 空
- `linked_by_user_id` 文字為空
- 時間戳

限制條件：

- 獨特的`(company_id, issue_id, approval_id)`

索引：

- `(company_id, issue_id)`
- `(company_id, approval_id)`

## 4. API 計劃

## 4.1 智能體補丁授權修復

更新 `PATCH /api/agents/:id` 授權矩陣：

- 董事會：允許
- 同一公司中的智能體角色 `ceo`：允許
- 否則：僅限自己

## 4.2 單獨的特權補丁字段

由非董事會/非首席執行官保護這些免受通用補丁的影響：

- `permissions`
- `status` 轉換超出允許範圍

（繼續使用專用權限路徑進行權限編輯。）

## 4.3 設定修改 APIs

添加：

- `GET /api/agents/:id/config-revisions`
- `GET /api/agents/:id/config-revisions/:revisionId`
- `POST /api/agents/:id/config-revisions/:revisionId/rollback`

行為：

- 回滾寫入新的修訂條目（不會改變歷史記錄）
- 回滾回應包括產生的活動配置

## 4.4 發布↔審批連結 APIs

添加：

- `GET /api/issues/:id/approvals`
- `POST /api/issues/:id/approvals`（連結現有核准）
- `DELETE /api/issues/:id/approvals/:approvalId`
- `GET /api/approvals/:id/issues`

## 4.5 建立批准時自動鏈接

擴展創建有效負載以選擇性地包含問題上下文：

- `POST /api/companies/:companyId/approvals` 支援 `issueId` 或 `issueIds`
- `POST /api/companies/:companyId/agent-hires` 支援 `sourceIssueId` 或 `sourceIssueIds`

伺服器行為：

- 首先建立批准
- 在 `issue_approvals` 中插入連結行

## 5. UI 計劃

## 5.1 智能體頁面

在`AgentDetail`上新增配置歷史面板：

- 修訂清單
- 差異預覽
- 附確認的回滾按鈕

## 5.2 審批頁面和問題頁面交叉鏈接

- 關於批准詳細資訊：顯示帶有連結的連結問題
- 關於問題詳細資訊：顯示帶有連結的連結批准
- 董事會上下文中的連結/取消連結操作

## 5.3 更好的評論使用者體驗提示

最初沒有硬編輯強制執行；更新幫助文字和模板以鼓勵連結的 Markdown 更新。

## 6.技能更新

## 6.1 `skills/paperclip/SKILL.md`

新增評論標準：

- 使用降價部分
- 包含相關實體的連結：
  - 批准：`/approvals/{id}`
  - 智能體：`/agents/{id}`
  - 問題：`/issues/{id}`

## 6.2 `skills/paperclip-create-agent/SKILL.md`

要求：

- 當根據問題創建僱用時，包括 `sourceIssueId`
- 使用 Markdown 評論回問題 + 批准和待處理智能體的鏈接

## 7. 實施階段

## A階段：Authz+安全加固

- 修復智能體路由中的 CEO 補丁授權
- 限制特權通用補丁字段
- 新增 authz 矩陣的測試

## B 階段：設定修訂帳本

- 加入`agent_config_revisions`
- 所有相關智能體突變的變更寫入
- 回滾端點+測試

## C 階段：Issue↔Approval 鏈接

- 加入`issue_approvals`
- 新增連結 APIs + 自動連結行為
- 更新批准/問題 UI 交叉鏈接

## D階段：技能指導

- 更新降價/連結期望和來源問題連結的技能

## 8. 驗收標準- CEO 可以成功修補 CTO（同一家公司）。
- 每個組態變更都會建立可檢索的修訂版本。
- 回滾可一次恢復先前的設定並建立新的修訂記錄。
- 發布和批准頁面顯示來自規範資料庫關係的穩定雙向連結。
- 招募工作流程中的智能體評論使用 Markdown 並包含實體連結。

## 9. 風險與緩解措施

- 風險：透過通用補丁進行權限升級。
  - 緩解措施：隔離特權欄位並驗證參與者範圍。
- 風險：回滾損壞。
  - 緩解措施：之前快照/之後快照 + 事務 + 測試。
- 風險：連結語意不明確。
  - 緩解措施：明確連結表+唯一約束+類型化關係欄位。