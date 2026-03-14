# CEO 智能體創建和招募治理計劃 (V1.1)

狀態： 擬定
日期：2026-02-19
擁有者：產品+伺服器+UI+技能

## 1. 目標

使 CEO 智能體能夠透過輕量級但明確的治理直接創建新智能體：

- 公司層級切換：新員工需要董事會批准（預設為開啟）。
- 座席級權限：`can_create_agents`（CEO 預設為開啟，其他人預設為關閉）。
- 明確招募工作流程以及草稿/不確定狀態，直至獲得批准。
- 配置反射，以便招聘智能體可以檢查可用的適配器配置並比較現有的智能體配置（包括自身配置）。
- 批准協作流程，包括評論、修訂請求和審計追蹤。

## 2. 目前狀態（回購現實）

- 智能體程式建立僅在 `POST /api/companies/:companyId/agents` (`server/src/routes/agents.ts`) 上進行。
- 審核支援`pending/approved/rejected/cancelled`和`hire_agent` + `approve_ceo_strategy`（`packages/shared/src/constants.ts`、`server/src/services/approvals.ts`）。
- `hire_agent` 批准目前僅在審批後建立智能體；沒有預先建立的地獄狀態智能體。
- 目前沒有智能體權限系統。
- 公司沒有「新進員工需要董事會批准」的規定。
- 批准沒有評論線程或修訂請求狀態。
- 收件匣和核准 UI 僅支援核准/拒絕；應用程式路由中不存在核准詳情路由。
- 智能體適配器配置為自由格式 JSON；不存在用於機器可讀或文字發現的運行時反射端點。

## 3. 產品決策

## 3.1 公司設置

新增公司設定：

- `requireBoardApprovalForNewAgents: boolean`
- 預設：`true`
- 只能在公司進階設定中編輯（不可在入職/公司建立流程 UI 中編輯）

## 3.2 智能體權限

現在引入一種具有明確權限的輕量級權限模型：

- `can_create_agents: boolean`

預設值：

- 執行長：`true`
- 其他人：`false`

權威機構：

- 董事會可以編輯任何智能體的權限。
- CEO可以編輯同一公司內智能體的權限。

此階段沒有更廣泛的 RBAC 系統。

## 3.3 招募的不確定狀態

引入專用的非運轉狀態：

- `pending_approval`

意義：

- 智能體記錄存在於組織樹中並且可以查看。
- 在獲得批准之前，智能體無法運作、接收分配、建立金鑰或恢復到活動狀態。

## 4. 資料模型更改

## 4.1 `companies`

新增列：

- `require_board_approval_for_new_agents` 布林值不為空預設值 `true`

需要同步：

- `packages/db/src/schema/companies.ts`
- `packages/shared/src/types/company.ts`
- `packages/shared/src/validators/company.ts`
- UI公司API類型使用及公司進階設定表格

## 4.2 `agents`

新增列：

- `permissions` jsonb 不為 null 預設 `{}`
- 狀態值擴展為包含 `pending_approval`

需要同步：

- `packages/db/src/schema/agents.ts`
- `packages/shared/src/constants.ts` (`AGENT_STATUSES`)
- `packages/shared/src/types/agent.ts`
- `packages/shared/src/validators/agent.ts`
- UI 中的狀態徽章、過濾器和生命週期控制

## 4.3 `approvals`將批准保留為中央治理記錄；擴展工作流程支援：

- 新增狀態`revision_requested`
- 確保僱用核准的有效負載包含：
  - `agentId`
  - `requestedByAgentId`
  - `requestedConfigurationSnapshot`

## 4.4 新建 `approval_comments` 表

新增批准討論線程：

- `id`、`company_id`、`approval_id`、`author_agent_id`、`author_user_id`、`body`、時間戳

目的：

- 評論評論
- 修改請求
- 批准/拒絕的理由
- 永久審計追踪

## 5. API 和 AuthZ 計劃

## 5.1 權限助手

新增伺服器端 authz 幫助程式：

- `assertCanCreateAgents(req, companyId)`
- `assertCanManageAgentPermissions(req, companyId)`

規則：

- 董事會總是通過。
- 智能體透過`can_create_agents`檢查自我授權是否真實且同一公司。
- 由執行長或董事會進行權限管理。

## 5.2 僱用創建流程

新增路線：

- `POST /api/companies/:companyId/agent-hires`

行為：

- 需要 `can_create_agents`（或板）。
- 首先建立智能體行。
- 如果公司設定需要批准：
  - 使用 `status=pending_approval` 建立智能體
  - 創建`approvals(type=hire_agent,status=pending,payload.agentId=...)`
  - 返回兩個智能體+批准
- 如果設定被停用：
  - 建立智能體為 `idle`
  - 無需審核記錄

董事會可能會繼續使用直接創建路線，但此路線成為執行長/智能體主導的招聘的規範。

## 5.3 審核工作流程端點

新增/擴充：

- `GET /api/approvals/:id`
- `POST /api/approvals/:id/request-revision`
- `POST /api/approvals/:id/resubmit`
- `GET /api/approvals/:id/comments`
- `POST /api/approvals/:id/comments`

更新現有的批准/拒絕語義：

- 批准僱用過渡連結智能體`pending_approval -> idle`
- 拒絕使連結智能體處於非活動狀態（`pending_approval` 或 `terminated`/稍後清除）

## 5.4 智能體權限管理端點

添加：

- `PATCH /api/agents/:id/permissions`

僅支援初始密鑰：

- `{ "canCreateAgents": boolean }`

## 5.5 讀取設定端點（受保護）

新增權限控制的配置讀取端點：

- `GET /api/companies/:companyId/agent-configurations`
- `GET /api/agents/:id/configuration`

訪問：

- 板
- 執行長
- 任何帶有`can_create_agents`的智能體

安全性：

- 從適配器配置中編輯明顯的秘密值（`env`、API 金鑰、令牌、JWT 外觀值）
- 在回應中包含編輯標記

## 5.6 適配器配置的反射端點

新增純文字反射路由：

- `GET /llms/agent-configuration.txt`
- `GET /llms/agent-configuration/:adapterType.txt`

索引檔案包括：

- 此 Paperclip 實例已安裝的適配器列表
- 每個適配器的文檔 URL
- 簡要「如何僱用」API 序列鏈接

每個適配器檔案包括：

- 必需/可選配置鍵
- 預設值
- 字段描述
- 安全注意事項
- 負載範例

授權：

- 與設定讀取端點相同的閘門（board/CEO/`can_create_agents`）。

## 6. 適配器協定擴展

擴展 `ServerAdapterModule` 合約以公開配置文件：

- `agentConfigurationDoc`（字串）或 `getAgentConfigurationDoc()`

實施於：

- `packages/adapters/claude-local`
- `packages/adapters/codex-local`
- `server/src/adapters/registry.ts`

這是必需的，以便從已安裝的適配器產生反射，而不是硬編碼。

## 7. UI 計劃## 7.1 公司進階設置

在公司 UI 中，新增進階設定面板/模式：

- 切換：「僱用新智能體需要董事會批准」（預設為開啟）

未顯示在入職流程中。

## 7.2 智能體權限UI

在智能體詳細資料（董事會/執行長背景）：

- 權限部分
- 切換“可以建立新智能體”

## 7.3 僱用使用者體驗

新增「僱用智能體」流程（適用於執行長/授權智能體）：

- 選擇角色/姓名/職位/報告對象
- 撰寫初始提示/功能
- 檢查適配器反射文檔
- 檢查現有的相關智能體配置
- 提交租金

狀態訊息：

- 如果需要批准：顯示“待董事會批准”
- 如果不需要：顯示活動就緒狀態

## 7.4 批准使用者體驗

新增審批詳細資訊頁面並擴展收件匣整合：

- `/approvals/:approvalId`
- 線索評論
- 修改請求操作
- 批准/拒絕並附有決定說明
- 活動時間表（建立、修訂、決定）

## 7.5 未經批准的智能體清理

在批准詳細資訊中提供僅限董事會的破壞性操作：

- “刪除未核准的智能體”
- 明確的確認對話框
- 保留批准+評論歷史記錄（審核）

## 8.新技能：`paperclip-create-agent`

建立新的技能目錄：

- `skills/paperclip-create-agent/SKILL.md`
- `skills/paperclip-create-agent/references/api-reference.md`

技能職責：

- 透過 `/llms/agent-configuration*.txt` 發現可用的適配器配置
- 讀取現有的智能體程式配置（包括自身和相關角色）
- 提出最適合目前環境的配置
- 為新智能體起草高品質的初始提示
- 設定經理/報告線
- 執行租用API流程
- 使用董事會評論處理修訂循環

另請更新 `skills/paperclip/SKILL.md` 以在招募工作流程中引用此技能。

## 9. 執行與不變量

新的/更新的不變量：

- `pending_approval` 智能體不能：
  - 被召喚/喚醒
  - 被分配的問題
  - 建立或使用 API 金鑰
  - 過渡到活躍的生命週期狀態，除非透過僱用批准
- 批准轉換：
  - `pending -> revision_requested | approved | rejected | cancelled`
  - `revision_requested -> pending | rejected | cancelled`
- 每個突變都會寫入 `activity_log` 記錄。

## 10. 實施階段

## 第 1 階段：合約與遷移

- 資料庫架構更新（`companies`、`agents`、審核狀態擴充、`approval_comments`）
- 共用常數/類型/驗證器更新
- 遷移生成和類型檢查

## 第 2 階段：伺服器授權 + 租用流程

- 權限解析器與授權守衛
- `agent-hires`路線
- 心跳/問題/關鍵流程中的邊緣狀態強制執行
- 核准修訂/評論端點

## 第 3 階段：反射與設定讀取 APIs

- 適配器協定文件支持
- `/llms/agent-configuration*.txt` 航線
- 透過編輯保護配置讀取端點

## 第 4 階段：UI 與技能

- 公司進階設定UI
- 權限控制
- 收件匣/核准中的核准詳細資料+評論/修訂流程
- 未核准的智能體刪除流程
- `paperclip-create-agent` 技能+文件更新## 11. 測試計劃

伺服器測試：

- 僱用/設定讀取/權限更新端點的權限門測試
- 僱用創造行為與公司設定開/關
- 批准過渡，包括修訂週期
- 喚醒/呼叫/分配/按鍵之間的pending_approval強制執行
- 配置編輯測試

使用者介面測試：

- 進階設定切換持久性
- 批准詳細評論/修訂交互
- 租賃流程狀態（待定與立即）

合併前的回購驗證：

- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

## 12. 風險與緩解措施

- 風險：透過智能體配置讀取外洩機密。
  - 緩解措施：嚴格的編輯通過 + 允許名單/拒絕名單測試。
- 風險：狀態爆炸的複雜性。
  - 緩解措施：具有明確轉換保護的單一新增狀態（`pending_approval`）。
- 風險：審批流程回歸。
  - 緩解措施：將轉換邏輯集中在審批服務中並透過測試進行支援。

## 13. 開放決策（預設推薦）

1. 董事會是否應該直接建立繞過審核設定？
建議：是的，董事會具有明確的治理優先權。

2. 未經授權的座席是否仍應看到基本的座席元資料？
建議：是（名稱/角色/狀態），但配置欄位仍然受到限制。

3. 拒絕後，Limbo Agent 應該保留 `pending_approval` 還是移動到 `terminated`？
建議：最終拒絕時移至`terminated`；保留可選的硬刪除操作以進行清理。