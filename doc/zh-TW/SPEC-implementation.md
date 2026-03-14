# Paperclip V1 實作規範

狀態：首次發布的實施合約 (V1)
日期：2026-02-17
受眾：產品、工程和智能體整合作者
來源輸入：`GOAL.md`、`PRODUCT.md`、`SPEC.md`、`DATABASE.md`、目前 monorepo 程式碼

## 1. 文檔角色

`SPEC.md` 仍然是長期產品規格。
本文檔是具體的、可建構的 V1 合約。
當發生衝突時，`SPEC-implementation.md` 控制 V1 行為。

## 2.V1 結果

Paperclip V1 必須為自治智能體提供完整的控制平面循環：

1. 董事會創建公司並確定目標。
2. 董事會在組織樹中創建和管理智能體。
3. 智能體程式透過心跳呼叫接收並執行任務。
4. 所有工作都透過具有審計可見性的任務/評論進行追蹤。
5. 報告代幣/成本使用情況，預算限制可能會停止工作。
6. 董事會可以在任何地方介入（暫停智能體/任務、推翻決策）。

成功意味著一名營運商可以以清晰的可見性和控制力端到端地經營小型人工智慧原生公司。

## 3. 明確的 V1 產品決策

這些決定結束了 `SPEC.md` 對 V1 的未決問題。

|主題 | V1 決定 |
|---|---|
|租賃 |單租戶部署、多公司資料模型 |
|公司模式|公司為一級；所有商業實體均屬於公司範圍|
|董事會|每次部署配備一名人員板操作員 |
|組織圖|嚴格樹（`reports_to` 根可為空）；沒有多經理報告|
|能見度|董事會和同一公司所有智能體的完全可見性|
|通訊 |僅任務+評論（沒有單獨的聊天系統）|
| 任務所有權|單一受讓人；`in_progress` 轉換需要原子結帳 |
|恢復|沒有自動重新分配；工作恢復仍然是手動/明確的 |
|智能體適配器|內建 `process` 和 `http` 適配器 |
|授權 |依賴模式的人工驗證（目前程式碼中的 `local_trusted` 隱式板；驗證模式使用會話），智能體程式的 API 金鑰 |
|預算期間|每月 UTC 日曆視窗 |
|預算執行|軟警報+硬限制自動暫停|
|部署模式 |規格模型為 `local_trusted` + `authenticated`，具有 `private/public` 暴露策略（請參閱 `doc/DEPLOYMENT-MODES.md`）|

## 4. 目前基準（回購快照）

截至 2026 年 2 月 17 日，該儲存庫已包括：

- 節點 + TypeScript 後端，附 REST CRUD，適用於 `agents`、`projects`、`goals`、ZXQQQ0024QQ
- React 控制台/智能體程式/專案/目標/問題清單的 UI 頁面
- 當 `DATABASE_URL` 未設定時，透過 Drizzle 嵌入 PostgreSQL 回退的 PostgreSQL 模式

V1 實施將此基準擴展為以公司為中心、具有治理意識的控制平面。

## 5.V1範圍

## 5.1 範圍- 公司生命週期（建立/清單/取得/更新/存檔）
- 與公司使命相關的目標層次
- 具有組織結構和適配器配置的智能體生命週期
- 具有父/子層次結構和註解的任務生命週期
- 原子任務簽出與顯式任務狀態轉換
- 董事會批准招募和執行長策略提案
- 心跳呼叫、狀態追蹤和取消
- 成本事件攝取和匯總（智能體/任務/項目/公司）
- 預算設定和硬停止執行
- 用於控制台、組織架構圖、任務、智能體、批准、成本的董事會 Web UI
- Agent的API合約（任務讀取/寫入、心跳報告、成本報告）
- 所有變異操作的可審計活動日誌

## 5.2 超出範圍 (V1)

- 外掛框架與第三方擴充SDK
- 模型/代幣成本以外的收入/費用會計
- 知識庫子系統
- 公共市場（ClipHub）
- 多板治理或基於角色的人員權限粒度
- 自動自我修復編排（自動重新分配/重試規劃器）

## 6. 架構

## 6.1 運行時元件

- `server/`：REST API，身份驗證，編排服務
- `ui/`：板操作員介面
- `packages/db/`：Drizzle 架構、遷移、資料庫用戶端 (Postgres)
- `packages/shared/`：共享 API 類型、驗證器、常數

## 6.2 資料存儲

- 主要：PostgreSQL
- 本地預設：在 `~/.paperclip/instances/default/db` 嵌入 PostgreSQL
- 可選的本地產品：Docker Postgres
- 選用託管：Supabase/Postgres 相容
- 檔案/物件儲存：
  - 本地預設：`~/.paperclip/instances/default/data/storage` (`local_disk`)
  - 雲端：S3相容的物件儲存（`s3`）

## 6.3 後台處理

伺服器進程中的輕量級調度程序/工作人員處理：

- 心跳觸發檢查
- 卡住運行檢測
- 預算門檻檢查

V1 不需要單獨的隊列基礎設施。

## 7. 規範資料模型 (V1)

除非另有說明，所有核心表均包括 `id`、`created_at`、`updated_at`。

## 7.0 驗證表

人工身份驗證表（`users`、`sessions` 和特定於提供者的身份驗證工件）由選定的身份驗證庫管理。此規範將它們視為必需的依賴項，並在需要使用者歸屬的地方引用 `users.id`。

## 7.1 `companies`

- `id` uuid pk
- `name` 文字不為空
- `description` 文字為空
- `status` 列舉：`active | paused | archived`

不變：每筆業務記錄都屬於一家公司。

## 7.2 `agents`- `id` uuid pk
- `company_id` uuid fk `companies.id` 不為空
- `name` 文字不為空
- `role` 文字不為空
- `title` 文字為空
- `status` 列舉：`active | paused | idle | running | error | terminated`
- `reports_to` uuid fk `agents.id` null
- `capabilities` 文字為空
- `adapter_type` 列舉：`process | http`
- `adapter_config` jsonb 不為空
- `context_mode` 枚舉：`thin | fat` 預設 `thin`
- `budget_monthly_cents` int 不為 null 預設 0
- `spent_monthly_cents` int 不為 null 預設 0
- `last_heartbeat_at` 時間戳空

不變量：

- 智能體和經理必須在同一家公司
- 報告樹中沒有循環
- `terminated`智能體無法恢復

## 7.3 `agent_api_keys`

- `id` uuid pk
- `agent_id` uuid fk `agents.id` 不為空
- `company_id` uuid fk `companies.id` 不為空
- `name` 文字不為空
- `key_hash` 文字不為空
- `last_used_at` 時間戳空
- `revoked_at` 時間戳空

不變：明文密鑰在建立時顯示一次；僅儲存雜湊值。

## 7.4 `goals`

- `id` uuid pk
- `company_id` uuid fk 不為空
- `title` 文字不為空
- `description` 文字為空
- `level` 列舉：`company | team | agent | task`
- `parent_id` uuid fk `goals.id` null
- `owner_agent_id` uuid fk `agents.id` null
- `status` 列舉：`planned | active | achieved | cancelled`

不變式：每家公司至少有一個根 `company` 等級目標。

## 7.5 `projects`

- `id` uuid pk
- `company_id` uuid fk 不為空
- `goal_id` uuid fk `goals.id` null
- `name` 文字不為空
- `description` 文字為空
- `status` 列舉：`backlog | planned | in_progress | completed | cancelled`
- `lead_agent_id` uuid fk `agents.id` null
- `target_date` 日期為空

## 7.6 `issues`（核心任務實體）

- `id` uuid pk
- `company_id` uuid fk 不為空
- `project_id` uuid fk `projects.id` null
- `goal_id` uuid fk `goals.id` null
- `parent_id` uuid fk `issues.id` null
- `title` 文字不為空
- `description` 文字為空
- `status` 列舉：`backlog | todo | in_progress | in_review | done | blocked | cancelled`
- `priority` 列舉：`critical | high | medium | low`
- `assignee_agent_id` uuid fk `agents.id` null
- `created_by_agent_id` uuid fk `agents.id` null
- `created_by_user_id` uuid fk `users.id` null
- `request_depth` int 不為 null 預設 0
- `billing_code` 文字為空
- `started_at` 時間戳空
- `completed_at` 時間戳空
- `cancelled_at` 時間戳空

不變量：

- 僅限單一受讓人
- 任務必須透過 `goal_id`、`parent_id` 或專案目標連結追溯到公司目標鏈
- `in_progress` 需要受讓人
- 終端狀態：`done | cancelled`

## 7.7 `issue_comments`

- `id` uuid pk
- `company_id` uuid fk 不為空
- `issue_id` uuid fk `issues.id` 不為空
- `author_agent_id` uuid fk `agents.id` null
- `author_user_id` uuid fk `users.id` null
- `body` 文字不為空

## 7.8 `heartbeat_runs`- `id` uuid pk
- `company_id` uuid fk 不為空
- `agent_id` uuid fk 不為空
- `invocation_source` 列舉：`scheduler | manual | callback`
- `status` 列舉：`queued | running | succeeded | failed | cancelled | timed_out`
- `started_at` 時間戳空
- `finished_at` 時間戳空
- `error` 文字為空
- `external_run_id` 文字為空
- `context_snapshot` jsonb 空

## 7.9 `cost_events`

- `id` uuid pk
- `company_id` uuid fk 不為空
- `agent_id` uuid fk `agents.id` 不為空
- `issue_id` uuid fk `issues.id` null
- `project_id` uuid fk `projects.id` null
- `goal_id` uuid fk `goals.id` null
- `billing_code` 文字為空
- `provider` 文字不為空
- `model` 文字不為空
- `input_tokens` int 不為 null 預設 0
- `output_tokens` int 不為 null 預設 0
- `cost_cents` int 不為空
- `occurred_at` 時間戳記不為空

不變性：每個事件必須附加到智能體和公司；匯總是聚合，從不手動編輯。

## 7.10 `approvals`

- `id` uuid pk
- `company_id` uuid fk 不為空
- `type` 列舉：`hire_agent | approve_ceo_strategy`
- `requested_by_agent_id` uuid fk `agents.id` null
- `requested_by_user_id` uuid fk `users.id` null
- `status` 列舉：`pending | approved | rejected | cancelled`
- `payload` jsonb 不為空
- `decision_note` 文字為空
- `decided_by_user_id` uuid fk `users.id` null
- `decided_at` 時間戳空

## 7.11 `activity_log`

- `id` uuid pk
- `company_id` uuid fk 不為空
- `actor_type` 列舉：`agent | user | system`
- `actor_id` uuid/文字不為空
- `action` 文字不為空
- `entity_type` 文字不為空
- `entity_id` uuid/文字不為空
- `details` jsonb 空
- `created_at` timestamptz 現在預設不為空()

## 7.12 `company_secrets` + `company_secret_versions`

- 秘密值不內嵌儲存在 `agents.adapter_config.env` 中。
- 智能體環境條目應使用敏感值的秘密引用。
- `company_secrets` 追蹤每家公司的身分/提供者元資料。
- `company_secret_versions` 儲存每個版本的加密/參考資料。
- 本機部署中的預設提供者：`local_encrypted`。

經營方針：

- 設定讀取 APIs 編輯敏感的普通值。
- 活動和批准有效負載不得保留原始敏感值。
- 配置修訂可能包括經過編輯的佔位符；對於已編輯的字段，此類修訂是不可恢復的。

## 7.13 所需索引

- `agents(company_id, status)`
- `agents(company_id, reports_to)`
- `issues(company_id, status)`
- `issues(company_id, assignee_agent_id, status)`
- `issues(company_id, parent_id)`
- `issues(company_id, project_id)`
- `cost_events(company_id, occurred_at)`
- `cost_events(company_id, agent_id, occurred_at)`
- `heartbeat_runs(company_id, agent_id, started_at desc)`
- `approvals(company_id, status, type)`
- `activity_log(company_id, created_at desc)`
- `assets(company_id, created_at desc)`
- `assets(company_id, object_key)` 獨特
- `issue_attachments(company_id, issue_id)`
- `company_secrets(company_id, name)` 獨特
- `company_secret_versions(secret_id, version)` 獨特

## 7.14 `assets` + `issue_attachments`- `assets` 儲存提供者支援的物件元資料（不是內嵌位元組）：
  - `id` uuid pk
  - `company_id` uuid fk 不為空
  - `provider` 枚舉/文本 (`local_disk | s3`)
  - `object_key` 文字不為空
  - `content_type` 文字不為空
  - `byte_size` int 不為空
  - `sha256` 文字不為空
  - `original_filename` 文字為空
  - `created_by_agent_id` uuid fk null
  - `created_by_user_id` uuid/文本 fk null
- `issue_attachments` 將資產連結到問題/評論：
  - `id` uuid pk
  - `company_id` uuid fk 不為空
  - `issue_id` uuid fk 不為空
  - `asset_id` uuid fk 不為空
  - `issue_comment_id` uuid fk null

## 8. 狀態機

## 8.1 智能體狀態

允許的轉換：

- `idle -> running`
- `running -> idle`
- `running -> error`
- `error -> idle`
- `idle -> paused`
- `running -> paused`（需取消流程）
- `paused -> idle`
- `* -> terminated`（僅限主機板，不可逆）

## 8.2 問題狀態

允許的轉換：

- `backlog -> todo | cancelled`
- `todo -> in_progress | blocked | cancelled`
- `in_progress -> in_review | blocked | done | cancelled`
- `in_review -> in_progress | done | cancelled`
- `blocked -> todo | in_progress | cancelled`
- 終端：`done`、`cancelled`

副作用：

- 輸入 `in_progress` 若為空則設定 `started_at`
- 輸入 `done` 設定 `completed_at`
- 輸入 `cancelled` 設定 `cancelled_at`

## 8.3 批准狀態

- `pending -> approved | rejected | cancelled`
- 決定後的終端

## 9. 授權與權限

## 9.1 板授權

- 人工操作員基於會話的身份驗證
- 董事會對部署中的所有公司具有完全讀/寫能力
- 每個主機板突變都會寫入`activity_log`

## 9.2 智能體驗證

- 承載 API 金鑰對應到一個智能體程式和公司
- 智能體關鍵範圍：
  - 閱讀自己公司的組織/任務/公司背景
  - 讀/寫自己分配的任務和評論
  - 為委託創建任務/評論
  - 報告心跳狀態
  - 報告成本事件
- 智能體不能：
  - 繞過審核關卡
  - 直接修改公司範圍的預算
  - 改變身份驗證/金鑰

## 9.3 權限矩陣（V1）

|行動|董事會|智能體|
|---|---|---|
|創建公司 |是的 |沒有|
|僱用/創建智能體 |是（直接）|請求通過批准 |
|暫停/恢復智能體 |是的 |沒有|
|建立/更新任務 |是的 |是的 |
|強制重新分配任務 |是的 |有限|
|批准策略/招聘請求 |是的 |沒有|
|報告費用 |是的 |是的 |
|設定公司預算|是的 |沒有|
|設定下級預算 |是的 |是（僅限管理器子樹）|

## 10. API 合約（REST）

所有端點都在`/api`下，並返回JSON。

## 10.1 公司

- `GET /companies`
- `POST /companies`
- `GET /companies/:companyId`
- `PATCH /companies/:companyId`
- `POST /companies/:companyId/archive`

## 10.2 目標

- `GET /companies/:companyId/goals`
- `POST /companies/:companyId/goals`
- `GET /goals/:goalId`
- `PATCH /goals/:goalId`
- `DELETE /goals/:goalId`（軟刪除可選，硬刪除僅板）

## 10.3 智能體- `GET /companies/:companyId/agents`
- `POST /companies/:companyId/agents`
- `GET /agents/:agentId`
- `PATCH /agents/:agentId`
- `POST /agents/:agentId/pause`
- `POST /agents/:agentId/resume`
- `POST /agents/:agentId/terminate`
- `POST /agents/:agentId/keys`（建立API金鑰）
- `POST /agents/:agentId/heartbeat/invoke`

## 10.4 任務（問題）

- `GET /companies/:companyId/issues`
- `POST /companies/:companyId/issues`
- `GET /issues/:issueId`
- `PATCH /issues/:issueId`
- `POST /issues/:issueId/checkout`
- `POST /issues/:issueId/release`
- `POST /issues/:issueId/comments`
- `GET /issues/:issueId/comments`
- `POST /companies/:companyId/issues/:issueId/attachments`（分段上傳）
- `GET /issues/:issueId/attachments`
- `GET /attachments/:attachmentId/content`
- `DELETE /attachments/:attachmentId`

### 10.4.1 原子結帳合約

`POST /issues/:issueId/checkout` 請求：

```json
{
  "agentId": "uuid",
  "expectedStatuses": ["todo", "backlog", "blocked"]
}
```

伺服器行為：

1. 使用 `WHERE id = ? AND status IN (?) AND (assignee_agent_id IS NULL OR assignee_agent_id = :agentId)` 進行單一 SQL 更新
2. 如果更新的行數為0，則傳回`409`以及目前所有者/狀態
3. 成功結帳設定`assignee_agent_id`、`status = in_progress`、`started_at`

## 10.5 項目

- `GET /companies/:companyId/projects`
- `POST /companies/:companyId/projects`
- `GET /projects/:projectId`
- `PATCH /projects/:projectId`

## 10.6 批准

- `GET /companies/:companyId/approvals?status=pending`
- `POST /companies/:companyId/approvals`
- `POST /approvals/:approvalId/approve`
- `POST /approvals/:approvalId/reject`

## 10.7 成本與預算

- `POST /companies/:companyId/cost-events`
- `GET /companies/:companyId/costs/summary`
- `GET /companies/:companyId/costs/by-agent`
- `GET /companies/:companyId/costs/by-project`
- `PATCH /companies/:companyId/budgets`
- `PATCH /agents/:agentId/budgets`

## 10.8 活動與控制台

- `GET /companies/:companyId/activity`
- `GET /companies/:companyId/dashboard`

控制台有效負載必須包括：

- 活動/運行/暫停/錯誤智能體計數
- 開放/進行中/阻止/完成的問題計數
- 本月迄今的支出與預算利用率
- 待批准計數

## 10.9 錯誤語意

- `400` 驗證錯誤
- `401` 未經身份驗證
- `403` 未經授權
- `404` 找不到
- `409` 狀態衝突（結帳衝突、無效轉換）
- `422` 語意規則違規
- `500` 伺服器錯誤

## 11. 心跳和適配器合約

## 11.1 適配器介面

```ts
interface AgentAdapter {
  invoke(agent: Agent, context: InvocationContext): Promise<InvokeResult>;
  status(run: HeartbeatRun): Promise<RunStatus>;
  cancel(run: HeartbeatRun): Promise<void>;
}
```

## 11.2 進程適配器

配置形狀：

```json
{
  "command": "string",
  "args": ["string"],
  "cwd": "string",
  "env": {"KEY": "VALUE"},
  "timeoutSec": 900,
  "graceSec": 15
}
```

行為：

- 生成子進程
- 串流標準輸出/標準錯誤以運行日誌
- 在退出代碼/逾時上標記運行狀態
- 取消發送 SIGTERM，然後在寬限後發送 SIGKILL

## 11.3 HTTP 轉接器

配置形狀：

```json
{
  "url": "https://...",
  "method": "POST",
  "headers": {"Authorization": "Bearer ..."},
  "timeoutMs": 15000,
  "payloadTemplate": {"agentId": "{{agent.id}}", "runId": "{{run.id}}"}
}
```

行為：

- 透過出站 HTTP 請求調用
- 2xx 表示已接受
- 非 2xx 標記呼叫失敗
- 可選的回調端點允許非同步完成更新

## 11.4 上下文傳遞

- `thin`：僅發送ID和指針；智能體透過 API 取得上下文
- `fat`：包含目前作業、目標摘要、預算快照和最近評論

## 11.5 調度規則

`adapter_config` 中的每個業務代表計畫欄位：

- `enabled` 布林值
- `intervalSec` 整數（最少 30）
- V1 的 `maxConcurrentRuns` 固定為 `1`

在以下情況下，調度程序必須跳過呼叫：

- 智能體已暫停/終止
- 現有運作處於活動狀態
- 已達硬預算限制

## 12. 治理與審批流程

## 12.1 招聘1. 智能體或董事會創建`approval(type=hire_agent, status=pending, payload=agent draft)`。
2. 董事會批准或拒絕。
3. 批准後，伺服器建立智能體行和初始 API 金鑰（可選）。
4. 決定記錄在`activity_log` 中。

Board可以繞過請求流程，直接透過UI建立智能體程式；直接建立仍被記錄為治理操作。

## 12.2 CEO 策略批准

1. CEO發布策略提案，編號為`approval(type=approve_ceo_strategy)`。
2. 董事會審查有效負荷（計畫文本、初始結構、高階任務）。
3. 批准解鎖執行長所創建的委派工作的執行狀態。

在首次戰略批准之前，CEO 只能起草任務，而不能將其轉變為主動執行狀態。

## 12.3 板覆蓋

董事會可以隨時：

- 暫停/恢復/終止任何智能體
- 重新分配或取消任何任務
- 編輯預算和限制
- 批准/拒絕/取消待批准

## 13. 成本與預算系統

## 13.1 預算層

- 公司每月預算
- 智能體每月預算
- 可選的專案預算（如果配置）

## 13.2 執行規則

- 軟警報預設閾值：80%
- 硬限制：100%時，觸發：
  - 將智能體狀態設定為`paused`
  - 阻止該智能體的新結帳/調用
  - 發出高優先活動事件

董事會可以透過提高預算或明確恢復智能體來推翻。

## 13.3 成本事件攝取

`POST /companies/:companyId/cost-events` 正文：

```json
{
  "agentId": "uuid",
  "issueId": "uuid",
  "provider": "openai",
  "model": "gpt-5",
  "inputTokens": 1234,
  "outputTokens": 567,
  "costCents": 89,
  "occurredAt": "2026-02-17T20:25:00Z",
  "billingCode": "optional"
}
```

驗證：

- 非負令牌計數
- `costCents >= 0`
- 所有關聯實體的公司所有權檢查

## 13.4 匯總

V1 可以接受讀取時聚合查詢。
如果查詢延遲超過目標，可以稍後新增物化總和。

## 14. UI 要求（Board 應用程式）

V1 UI路線：

- `/` 控制台
- `/companies` 公司列表/創建
- `/companies/:id/org` 組織架構圖與智能體狀態
- `/companies/:id/tasks` 任務清單/看板
- `/companies/:id/agents/:agentId` 智能體詳情
- `/companies/:id/costs` 成本與預算控制台
- `/companies/:id/approvals` 待批准/歷史批准
- `/companies/:id/activity` 稽核/事件流

所需的使用者體驗行為：

- 全球公司選擇器
- 快速操作：暫停/恢復智能體、建立任務、批准/拒絕請求
- 原子結帳失敗時發生衝突
- 沒有靜默的後台故障；每個失敗的運作都在 UI 中可見

## 15. 操作要求

## 15.1 環境

- 節點 20+
- `DATABASE_URL` 可選
- 如果未設置，則自動使用 PGlite 和推送模式

## 15.2 遷移

- 毛毛雨遷徙是真相的來源
- V1 升級路徑沒有破壞性遷移
- 提供從現有最小表到公司範圍架構的遷移腳本

## 15.3 日誌記錄和審計

- 結構化日誌（JSON 生產中）
- 每次 API 呼叫請求 ID
- 每個突變都寫成`activity_log`

## 15.4 可靠度目標- API 對於 1k 任務/公司的標準 CRUD，p95 延遲低於 250 毫秒
- 進程適配器的心跳呼叫確認在 2 秒內完成
- 不會遺失核准決策（事務寫入）

## 16. 安全要求

- 僅儲存雜湊智能體 API 金鑰
- 編輯日誌中的秘密（`adapter_config`、驗證標頭、環境變數）
- 針對董事會會話端點的 CSRF 保護
- 速率限制身份驗證和金鑰管理端點
- 對每個實體獲取/突變進行嚴格的公司邊界檢查

## 17. 測試策略

## 17.1 單元測試

- 國家過渡警衛（智能體、發行、批准）
- 預算執行規則
- 適配器呼叫/取消語義

## 17.2 整合測試

- 原子結帳衝突行為
- 批准到智能體創建流程
- 成本攝取與總結正確性
- 運行時暫停（優雅取消然後強制終止）

## 17.3 端對端測試

- 董事會創建公司 -> 聘請執行長 -> 批准策略 -> 執行長接受工作
- 智能體報告成本 -> 達到預算門檻 -> 發生自動暫停
- 跨團隊的任務委派，請求深度增量

## 17.4 迴歸套件最小值

除非通過以下條件，否則候選版本將被封鎖：

1. 授權邊界測試
2. 結帳比賽測試
3. 硬預算停止測試
4. 智能體暫停/恢復測試
5. 儀錶板匯總一致性測試

## 18. 交付計劃

## 里程碑 1：公司核心與授權

- 將 `companies` 和公司範圍新增至現有實體
- 新增董事會會話驗證和智能體 API 金鑰
- 將現有的 API 路由遷移到公司感知的路徑

## 里程碑 2：任務與治理語意

- 實現原子結帳端點
- 實施問題評論與生命週期守衛
- 實施審核表和僱用/策略工作流程

## 里程碑 3：心跳和轉接器運作時

- 實作適配器接口
- 提供具有取消語意的 `process` 轉接器
- 提供具有逾時/錯誤處理功能的 `http` 轉接器
- 持續心跳運行和狀態

## 里程碑 4：成本與預算控制

- 實施成本事件攝取
- 實施每月匯總和控制台
- 強制執行硬限制自動暫停

## 里程碑 5：董事會 UI 完成

- 新增公司選擇器和組織架構圖視圖
- 新增審核和成本頁面

## 里程碑 6：強化與發布

- 完全整合/e2e套件
- 用於本地測試的種子/演示公司模板
- 發布清單和文件更新

## 19. 驗收標準（釋放門）

只有當所有條件都為真時，V1 才完整：1. 一個董事會使用者可以創建多個公司並在多個公司之間切換。
2. 一家公司可以運行至少一個啟用心跳的活動智能體。
3. 任務簽出與 `409` 在並發聲明上是衝突安全的。
4. 智能體只能使用API密鑰更新任務/評論和報告費用。
5. 董事會可以在 UI 中批准/拒絕招募和 CEO 策略請求。
6. 預算硬限制會自動暫停智能體並阻止新的呼叫。
7. 控制台顯示即時資料庫資料的準確計數/支出。
8. 每個突變都可以在活動日誌中進行審核。
9. 應用程式預設與嵌入式 PostgreSQL 一起運行，並透過 `DATABASE_URL` 與外部 Postgres 一起運行。

## 20.V1 後積壓（明確延後）

- 插件架構
- 每個團隊更豐富的工作流程狀態定制
- 里程碑/標籤/依賴圖深度超出 V1 最小值
- 即時傳輸最佳化（SSE/WebSockets）
- 公共範本市場整合（ClipHub）

## 21. 公司可移植性套件（V1 附錄）

V1支援使用便攜式打包合約的公司匯入/匯出：

- 剛好一個 JSON 入口點：`paperclip.manifest.json`
- 所有其他套件檔案都是帶有 frontmatter 的 markdown
- 智能體約定：
  - `agents/<slug>/AGENTS.md`（V1匯出/匯入所需）
  - `agents/<slug>/HEARTBEAT.md`（可選，接受導入）
  - `agents/<slug>/*.md`（可選，接受導入）

V1 中的匯出/匯入行為：

- 匯出包括基於選擇的公司元資料和/或智能體
- 匯出條帶環境特定路徑（`cwd`，本機指令檔案路徑）
- 匯出從不包含秘密值；報告秘密要求
- 導入支援目標模式：
  - 創建一家新公司
  - 導入現有公司
- 導入支援碰撞策略：`rename`、`skip`、`replace`
- 導入支援應用前預覽（試運行）