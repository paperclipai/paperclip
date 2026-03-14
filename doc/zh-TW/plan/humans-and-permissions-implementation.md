# 人員和權限實施 (V1)

狀態：草案
日期：2026-02-21
擁有者：伺服器+UI+CLI+DB+共享
伴侶計畫：`doc/plan/humans-and-permissions.md`

## 1.文檔角色

本文件是人員與權限計畫的工程實施合約。
它將產品決策轉化為具體的模式、API、中介軟體、UI、CLI 和測試工作。

如果本文檔與先前的探索性註解衝突，則本文檔優先執行 V1。

## 2. 鎖定 V1 決策

1. 仍保留兩種部署模式：
- `local_trusted`
- `cloud_hosted`

2. `local_trusted`：
- 沒有登入使用者體驗
- 隱式本地實例管理員參與者
- 僅環回伺服器綁定
- 本地可用的完整管理/設定/邀請/批准功能

3. `cloud_hosted`：
- 更好的人類身份驗證
- 僅電子郵件/密碼
- V1 中沒有電子郵件驗證要求

4、權限：
- 人類和智能體的一個共享授權系統
- 標準化補助金表（`principal_permission_grants`）
- 沒有單獨的“智能體權限引擎”

5、邀請：
- 僅複製連結（V1 中不發送出站電子郵件）
- 統一`company_join`鏈接，支援人工或智能體路徑
- 接受建立 `pending_approval` 加入請求
- 在管理員批准之前無法訪問

6. 加入評論元資料：
- 需要來源IP
- V1 中沒有 GeoIP/國家查找

7. 智能體API鑰匙：
- 預設無限期
- 靜態哈希
- 索賠時顯示一次
- 支援撤銷/重新生成

8. 本地入口：
- 公共/不受信任的入口超出了 V1 的範圍
- V1 中沒有 `--dangerous-agent-ingress`

## 3. 當前基準與增量

目前基準（截至本文檔的回購）：

- 伺服器演員模型預設為 `server/src/middleware/auth.ts` 中的 `board`
- 授權大多為`assertBoard` + 公司簽入`server/src/routes/authz.ts`
- 本機模式中沒有人工身份驗證/會話表
- 沒有主要會員資格或補助金表
- 無邀請或加入請求生命週期

所需增量：

- 從董事會與智能體的授權轉向基於主體的授權
- 在雲端模式下添加更好的身份驗證集成
- 新增會員資格/補助/邀請/加入請求持久性
- 新增核准收件匣訊號和操作
- 保留本地無登入使用者體驗而不削弱雲端安全性

## 4. 架構

## 4.1 部署模式合約

新增顯式運行時模式：

- `deployment.mode = local_trusted | cloud_hosted`

配置行為：

- 模式儲存在設定檔中（`packages/shared/src/config-schema.ts`）
- 載入到伺服器設定（`server/src/config.ts`）
- 出現在`/api/health`

啟動護欄：

- `local_trusted`：如果綁定主機不是環回，則啟動失敗
- `cloud_hosted`：如果未設定 Better Auth，啟動失敗

## 4.2 演員模型

用顯式參與者取代隱式「板」語意：

- `user`（會話驗證的人類）
- `agent`（承載API金鑰）
- `local_implicit_admin`（僅限 local_trusted）

實施注意事項：- 透過引入標準化器助手，在遷移過程中保持 `req.actor` 形狀向後相容
- 在新的 authz 助理就位後刪除硬編碼的 `"board"` 逐路由檢查

## 4.3 授權模型

授權輸入元組：

- `(company_id, principal_type, principal_id, permission_key, scope_payload)`

主要類型：

- `user`
- `agent`

角色層：

- `instance_admin`（實例範圍）
- 透過 `principal_permission_grants` 獲得公司範圍內的資助

評價順序：

1. 從actor解析principal
2. 解析實例角色（`instance_admin` 僅限管理員操作的短路）
3. 解析公司會員（公司接取需`active`）
4. 解決撥款+請求行動的範圍

## 5. 資料模型

## 5.1 更好的身份驗證表

由 Better Auth 適配器/遷移管理（預計最少）：

- `user`
- `session`
- `account`
- `verification`

注意：

- 使用 Better Auth 規範表名稱/類型來避免自訂分叉

## 5.2 新 Paperclip 表

1. `instance_user_roles`

- `id` uuid pk
- `user_id` 文字不為空
- `role` 文字不為空 (`instance_admin`)
- `created_at`, `updated_at`
- 唯一索引：`(user_id, role)`

2. `company_memberships`

- `id` uuid pk
- `company_id` uuid fk `companies.id` 不為空
- `principal_type` 文字不為空 (`user | agent`)
- `principal_id` 文字不為空
- `status` 文字不為空 (`pending | active | suspended`)
- `membership_role` 文字為空
- `created_at`, `updated_at`
- 唯一索引：`(company_id, principal_type, principal_id)`
- 索引：`(principal_type, principal_id, status)`

3. `principal_permission_grants`

- `id` uuid pk
- `company_id` uuid fk `companies.id` 不為空
- `principal_type` 文字不為空 (`user | agent`)
- `principal_id` 文字不為空
- `permission_key` 文字不為空
- `scope` jsonb 空
- `granted_by_user_id` 文字為空
- `created_at`, `updated_at`
- 唯一索引：`(company_id, principal_type, principal_id, permission_key)`
- 索引：`(company_id, permission_key)`

4. `invites`

- `id` uuid pk
- `company_id` uuid fk `companies.id` 不為空
- `invite_type` 文字不為空 (`company_join | bootstrap_ceo`)
- `token_hash` 文字不為空
- `company_join` 的 `allowed_join_types` 文字不為空 (`human | agent | both`)
- `defaults_payload` jsonb 空
- `expires_at` 時間戳記不為空
- `invited_by_user_id` 文字為空
- `revoked_at` 時間戳空
- `accepted_at` 時間戳空
- `created_at` timestamptz 現在預設不為空()
- 唯一索引：`(token_hash)`
- 索引：`(company_id, invite_type, revoked_at, expires_at)`

5. `join_requests`- `id` uuid pk
- `invite_id` uuid fk `invites.id` 不為空
- `company_id` uuid fk `companies.id` 不為空
- `request_type` 文字不為空 (`human | agent`)
- `status` 文字不為空 (`pending_approval | approved | rejected`)
- `request_ip` 文字不為空
- `requesting_user_id` 文字為空
- `request_email_snapshot` 文字為空
- `agent_name` 文字為空
- `adapter_type` 文字為空
- `capabilities` 文字為空
- `agent_defaults_payload` jsonb 空
- `created_agent_id` uuid fk `agents.id` null
- `approved_by_user_id` 文字為空
- `approved_at` 時間戳空
- `rejected_by_user_id` 文字為空
- `rejected_at` 時間戳空
- `created_at`, `updated_at`
- 索引：`(company_id, status, request_type, created_at desc)`
- 唯一索引：`(invite_id)` 對每個消費的邀請強制執行一個請求

## 5.3 現有表格更改

1. `issues`

- 新增`assignee_user_id`文字空
- 強制執行單一受讓人不變式：
  - `assignee_agent_id` 和 `assignee_user_id` 至多其中之一為非空

2. `agents`

- 保留現有的 `permissions` JSON 僅用於過渡
- 一旦主體授權生效，就在程式碼路徑中標記為已棄用

## 5.4 遷移策略

遷移順序：

1. 新增新的表/列/索引
2. 回填現有資料的最低會員資格/補助：
- 在運行時以本機模式建立本機隱式管理成員身份上下文（不保留為更好的身份驗證使用者）
- 對於雲，引導程式在接受時建立第一個管理員使用者角色
3. 將authz讀取切換到新表
4. 刪除傳統的僅董事會檢查

## 6. API 合約（新增/變更）

全部位於`/api`下。

## 6.1 健康

`GET /api/health` 回覆補充：

- `deploymentMode`
- `authReady`
- `bootstrapStatus` (`ready | bootstrap_pending`)

## 6.2 邀請

1. `POST /api/companies/:companyId/invites`
- 創建 `company_join` 邀請
- 複製連結值回傳一次

2. `GET /api/invites/:token`
- 驗證令牌
- 返回邀請著陸有效載荷
- 包括`allowedJoinTypes`

3. `POST /api/invites/:token/accept`
- 身體：
  - `requestType: human | agent`
  - 人為路徑：除了經過身份驗證的使用者之外，沒有額外的有效負載
  - 智能體路徑：`agentName`、`adapterType`、`capabilities`，選用適配器預設值
- 消耗邀請令牌
- 創建`join_requests(status=pending_approval)`

4. `POST /api/invites/:inviteId/revoke`
- 撤銷未消費的邀請

## 6.3 加入請求

1. `GET /api/companies/:companyId/join-requests?status=pending_approval&requestType=...`

2. `POST /api/companies/:companyId/join-requests/:requestId/approve`
- 人類：
  - 建立/啟動`company_memberships`
  - 應用預設補助金
- 智能體：
  - 建立 `agents` 行
  - 為 API 金鑰建立待處理的索賠上下文
  - 建立/啟動智能體會員資格
  - 應用預設補助金

3. `POST /api/companies/:companyId/join-requests/:requestId/reject`

4. `POST /api/join-requests/:requestId/claim-api-key`
- 僅經批准的智能體請求
- 傳回一次明文金鑰
- 將雜湊值儲存在 `agent_api_keys` 中

## 6.4 會員資格和補助金

1. `GET /api/companies/:companyId/members`
- 傳回兩種主要類型

2. `PATCH /api/companies/:companyId/members/:memberId/permissions`
- 更新插入/刪除補助金

3. `PUT /api/admin/users/:userId/company-access`
- 只限實例管理員

4. `GET /api/admin/users/:userId/company-access`

5. `POST /api/admin/users/:userId/promote-instance-admin`

6. `POST /api/admin/users/:userId/demote-instance-admin`

## 6.5 收件匣

`GET /api/companies/:companyId/inbox` 補充：- 當參與者可以 `joins:approve` 時待處理的加入請求警報項目
- 每個項目都包含內聯操作元資料：
  - 加入請求 ID
  - 請求類型
  - 來源IP
  - 適用時的手動電子郵件快照

## 7. 伺服器實作細節

## 7.1 設定與啟動

文件：

- `packages/shared/src/config-schema.ts`
- `server/src/config.ts`
- `server/src/index.ts`
- `server/src/startup-banner.ts`

變化：

- 新增部署模式+綁定主機設置
- 僅對 `local_trusted` 強制執行環回
- 在 `cloud_hosted` 中強制執行更好的身份驗證準備
- 橫幅顯示模式和開機狀態

## 7.2 更好的身份驗證集成

文件：

- `server/package.json`（依賴）
- `server/src/auth/*`（新）
- `server/src/app.ts`（掛載驗證處理程序端點+會話中間件）

變化：

- 新增更好的身份驗證伺服器實例
- 雲端模式的cookie/會話處理
- 本機模式下的無操作會話身份驗證

## 7.3 Actor 中介軟體

文件：

- `server/src/middleware/auth.ts`
- `server/src/routes/authz.ts`
- `server/src/middleware/board-mutation-guard.ts`

變化：

- 停止預設每個在雲端模式下登機的請求
- 在本機模式下將本機請求對應到 `local_implicit_admin` actor
- 在雲端模式下將 Better Auth 會話對應到 `user` actor
- 保留智能體承載路徑
- 用面向權限的助手取代 `assertBoard`：
  - `requireInstanceAdmin(req)`
  - `requireCompanyAccess(req, companyId)`
  - `requireCompanyPermission(req, companyId, permissionKey, scope?)`

## 7.4 授權服務

文件：

- `server/src/services`（新模組）
  - `memberships.ts`
  - `permissions.ts`
  - `invites.ts`
  - `join-requests.ts`
  - `instance-admin.ts`

變化：

- 集中權限評估
- 集中的會員決議
- 主要類型分支的一處

## 7.5 路線

文件：

- `server/src/routes/index.ts` 和新的路線模組：
  - `auth.ts`（如果需要）
  - `invites.ts`
  - `join-requests.ts`
  - `members.ts`
  - `instance-admin.ts`
  - `inbox.ts`（或現有收件匣來源的擴充）

變化：

- 新增上面列出的新端點
- 一致地應用公司和權限檢查
- 透過活動日誌服務記錄所有突變

## 7.6 活動日誌與審核

文件：

- `server/src/services/activity-log.ts`
- 在邀請/加入/成員/管理路線中呼叫站點

所需採取的行動：

- `invite.created`
- `invite.revoked`
- `join.requested`
- `join.approved`
- `join.rejected`
- `membership.activated`
- `permission.granted`
- `permission.revoked`
- `instance_admin.promoted`
- `instance_admin.demoted`
- `agent_api_key.claimed`
- `agent_api_key.revoked`

## 7.7 即時與收件匣傳播

文件：

- `server/src/services/live-events.ts`
- `server/src/realtime/live-events-ws.ts`
- 收件匣資料來源端點

變化：

- 發出加入請求事件
- 確保收件匣刷新路徑包括加入警報

## 8. CLI 實現

文件：

- `cli/src/index.ts`
- `cli/src/commands/onboard.ts`
- `cli/src/commands/configure.ts`
- `cli/src/prompts/server.ts`

命令：

1. `paperclipai auth bootstrap-ceo`
- 建立引導邀請
- 列印一次性 URL

2. `paperclipai onboard`
- 在雲端模式下使用 `bootstrap_pending`，列印引導程式 URL 和後續步驟
- 在本機模式下，跳過引導程式要求

配置補充：

- 部署模式
- 綁定主機（針對模式進行驗證）

## 9. UI 實現文件：

- 路由：`ui/src/App.tsx`
- API 客戶：`ui/src/api/*`
- 頁面/元件（新）：
  - `AuthLogin` / `AuthSignup`（雲模式）
  - `BootstrapPending`頁面
  - `InviteLanding`頁面
  - `InstanceSettings`頁面
  - 在`Inbox`中加入審核元件
  - 公司環境中的會員/資助管理

所需的使用者體驗：

1. 雲端未認證用戶：
- 重定向到登入/註冊

2. 雲端引導待處理：
- 透過設定命令指導阻止應用程式

3、邀請登陸：
- 選擇人類與智能體路徑（尊重`allowedJoinTypes`）
- 提交加入請求
- 顯示待批准確認

4. 收件匣：
- 顯示帶有批准/拒絕操作的加入批准卡
- 包含來源 IP 和手動電子郵件快照（如果適用）

5. 本地模式：
- 沒有登入提示
- 提供完整的設定/邀請/批准使用者介面

## 10. 安全控制

1. 令牌處理

- 邀請令牌靜態雜湊
- API 金鑰靜態雜湊
- 僅顯示一次性明文金鑰

2. 本地模式隔離

- 環回綁定強制
- 在非環回主機上啟動硬故障

3. 雲端認證

- 沒有隱式的董事會後備
- 人類突變必須進行會話驗證

4. 加入工作流程強化

- 每個邀請令牌一個請求
- 待處理的請求沒有資料存取權限
- 會員啟動前需獲得批准

5. 濫用控制

- 速率限制邀請接受和關鍵聲明端點
- 針對加入和聲明失敗的結構化日誌記錄

## 11. 遷移與相容性

## 11.1 執行時期相容性

- 在遷移 authz 幫助程式使用時保持現有的依賴於板的路由功能
- 僅在許可助理覆蓋所有路線後才逐步淘汰 `assertBoard` 呼叫

## 11.2 資料相容性

- 不要在V1中刪除`agents.permissions`
- 撥款一旦匯出就停止閱讀
- 在 V1 後清理遷移中刪除

## 11.3 更好的身份驗證使用者 ID 處理

- 將 `user.id` 視為端對端文本
- 現有的 `created_by_user_id` 和類似的文字欄位仍然有效

## 12. 測試策略

## 12.1 單元測試

- 權限評估器：
  - 實例管理員繞過
  - 撥款支票
  - 範圍檢查
- 加入批准狀態機
- 邀請代幣生命週期

## 12.2 整合測試

- 雲模式未認證變異->`401`
- 本地模式隱式管理突變 -> 成功
- 邀請接受 -> 待加入 -> 無訪問權限
- 加入批准（人類）-> 會員資格/贈款活動
- 加入批准（智能體）->關鍵索賠一次
- 使用者和智能體主體的跨公司存取被拒絕
-本地模式非環回綁定->啟動失敗

## 12.3 UI 測試

- 雲端模式登入門
- 引導掛起螢幕
- 邀請登陸選擇路徑UX
- 收件匣加入警報核准/拒絕流程

## 12.4 迴歸測試

- 現有智能體API關鍵流程仍然有效
- 任務分配與結帳不變量不變
- 仍發出所有突變的活動日誌記錄## 13. 交付計劃

## A 階段：基礎

- 配置模式/綁定主機支持
- 啟動護欄
- 更好的身份驗證整合框架
- 演員類型擴展

## B 階段：架構與 authz 核心

- 新增會員資格/補助/邀請/加入表
- 新增權限服務和助手
- 電線公司/會員/實例管理員檢查

## C階段：邀請+加入後端

- 邀請建立/撤銷
- 邀請接受 -> 待處理請求
- 批准/拒絕+關鍵聲明
- 活動日誌+現場活動

## D階段：UI + CLI

- 雲端登入/引導螢幕
- 邀請登陸
- 收件匣加入審核操作
- 實例設定和成員權限
- 引導 CLI 指令和入門更新

## E 階段：強化

- 全面整合/端對端覆蓋
- 文件更新（`SPEC-implementation`、`DEVELOPING`、`CLI`）
- 清理遺留的僅板程式碼路徑

## 14.驗證門

交接前：

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

如果跳過任何命令，請準確記錄跳過的內容及其原因。

## 15. 完成標準

1. 行為與本文檔和`doc/plan/humans-and-permissions.md`中鎖定的V1決策相符。
2、雲端模式需要授權；本機模式沒有登入 UX。
3. 統一的邀請+待審批流程適用於人員和座席。
4. 共享主體會員資格+權限系統對使用者和智能體生效。
5. 本機模式保持僅環回，否則會失敗。
6. 收件匣顯示可操作的加入核准。
7. 所有新的變異路徑都會被記錄活動。