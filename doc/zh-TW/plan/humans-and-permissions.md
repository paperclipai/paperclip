# 人員和權限計劃

狀態：草案
日期：2026-02-21
所有者：服务器+UI+共享+数据库

## 目標

增加一流的人類使用者和權限，同時保留兩種部署模式：

- 本地可信单用户模式，无登录摩擦
- 雲端託管多用戶模式，具有強制身份驗證和授權

## 為什麼這個計劃

目前的 V1 假設以一名董事會運營商為中心。我們現在需要：

- 具有每个用户权限的多人协作
- 安全的雲端部署預設值（不會出現意外的無登入生產）
- 本地模式仍然感覺即時（`npx paperclipai run` 並繼續）
- 智能體到人類的任務委託，包括人類收件匣
- 一個使用者帳戶可在一次部署中存取多個公司
- 實例管理員可以管理公司對實例的訪問
- 加入批准作為可操作的收件匣警報出現，而不是隱藏在僅限管理的頁面中
- 面向人類和智能體的對稱邀請和批准加入路徑
- 一種供人類和智能體共享的成員資格和權限模型

## 產品限制

1. 對每個新表、端點和權限檢查保持嚴格的公司範圍。
2. 保留现有的控制平面不变量：

- 单受让人任务模型
- 審核門
- 預算硬停止行為
- 突變活動記錄

3. 保持本地模式簡單且可信，但防止不安全的雲端狀態。

## 部署模式

## 模式A：`local_trusted`

行為：

- 沒有登入介面
- 瀏覽器直接開啟到棋盤上下文中
- 保留嵌入式資料庫和本機儲存預設值
- 存在本地隱含人類演員以進行歸因
- 本地隱式參與者對此實例具有有效的 `instance_admin` 權限
- 完整的邀請/批准/權限設定流程在本地模式下仍然可用（包括智能體註冊）

護欄：

- 伺服器預設綁定到環回
- 如果模式為 `local_trusted` 且具有非環回綁定，則啟動失敗
- 使用者介面顯示持久的「本地可信任模式」徽章

## 模式B：`cloud_hosted`

行為：

- 所有人类端点都需要登录
- 更好的人類身份驗證
- 初始身份验证方法：电子邮件+密码
- 首次发布不需要电子邮件验证
- 支援託管資料庫和遠端部署
- 多用戶會話和角色/權限強制執行

護欄：

- 如果缺少身份驗證提供者/會話配置，則啟動失敗
- 如果設定了不安全的身份驗證繞過標誌，則啟動失敗
- 健康負載包括模式和身份驗證準備情況

## 身份驗證選擇

- 对人类用户使用更好的身份验证
- 仅从电子邮件/密码登录开始
- V1 中没有电子邮件确认要求
- 保持實施結構化，以便日後新增社交/SSO 提供者，而無需更改成員資格/權限語意

## Auth 和 Actor 模型

將請求參與者統一到單一模型：- `user`（經過驗證的人類）
- `agent`（API 金鑰）
- `local_board_implicit`（僅限本地信任模式）

規則：

- 在`cloud_hosted`中，只有`user`和`agent`是有效的演員
- 在`local_trusted`中，未經驗證的瀏覽器/API請求解析為`local_board_implicit`
- `local_board_implicit` 被授權為本機操作的實例管理員主體
- 所有變異動作繼續使用演員類型/id寫入`activity_log`

## 第一個管理引導程式

問題：

- 新的雲端部署需要安全、明確的第一人工管理路徑
- 應用程式不能採用預先存在的管理員帳戶
- `local_trusted` 不使用開機流程，因為隱式本機實例管理已存在

引導流程：

1. 如果部署中不存在 `instance_admin` 用戶，則實例處於 `bootstrap_pending` 狀態。
2. CLI 指令 `pnpm paperclipai auth bootstrap-ceo` 為此實例建立一次性 CEO 入職邀請 URL。
3. `pnpm paperclipai onboard` 執行此引導程式檢查並在 `bootstrap_pending` 時自動列印邀請 URL。
4. 在 `bootstrap_pending` 時存取應用程式會顯示阻止設定頁面，其中包含要執行的確切 CLI 命令 (`pnpm paperclipai onboard`)。
5. 接受 CEO 邀請將建立第一個管理員使用者並退出引導模式。

安全規則：

- 引導程式邀請是一次性的、短暫的、靜態儲存的令牌哈希
- 每個實例一次只有一個有效的引導程式邀請（重新產生會撤銷先前的令牌）
- 引導操作在 `activity_log` 中進行審核

## 資料模型添加

## 新表

1. `users`

- 人類使用者的身份記錄（基於電子郵件）
- 用於管理權限的可選實例級角色欄位（或伴隨表）

2. `company_memberships`

- `company_id`、`principal_type` (`user | agent`)、`principal_id`
- 狀態（`pending | active | suspended`），角色元數據
- 儲存人類和智能體的有效存取狀態
- 多對多：一個主體可以屬於多個公司

3. `invites`

- `company_id`、`invite_type` (`company_join | bootstrap_ceo`)、令牌雜湊、expires_at、invited_by、revoked_at、accepted_at
- 一次分享連結（無預先綁定的邀請電子郵件）
- `allowed_join_types` (`human | agent | both`) 用於 `company_join` 鏈接
- 可選預設負載由連線類型鍵入：
  - 人類預設：初始權限/成員角色
  - 智能體預設值：建議的角色/頭銜/適配器預設值

4. `principal_permission_grants`

- `company_id`、`principal_type` (`user | agent`)、`principal_id`、`permission_key`
- 明確授予，例如 `agents:create`
- 包括命令鏈限制的範圍有效負載
- 用於可審核授予/撤銷歷史記錄的規範化表（不是 JSON blob）

5. `join_requests`- `invite_id`、`company_id`、`request_type` (`human | agent`)
- `status` (`pending_approval | approved | rejected`)
- 共同評論元資料：
  - `request_ip`
  - `approved_by_user_id`、`approved_at`、`rejected_by_user_id`、`rejected_at`
- 人工請求欄位：
  - `requesting_user_id`, `request_email_snapshot`
- 智能體請求欄位：
  - `agent_name`、`adapter_type`、`capabilities`、`created_agent_id` 在獲得批准之前可為空
- 選擇加入類型後，每個消費的邀請都會建立一個加入請求記錄

6. `issues` 擴展

- 新增 `assignee_user_id` 可為空
- 透過 XOR 檢查保留單受讓人不變式：
  - `assignee_agent_id` / `assignee_user_id` 中的零個或之一

## 相容性

- 現有的 `created_by_user_id` / `author_user_id` 欄位保留並完全活躍
- 智能體 API 金鑰保留身分驗證憑證；會員資格+補助金仍是授權來源

## 權限模型（初始設定）

原理：

- 人類和智能體使用相同的會員資格+贈款評估引擎
- 針對兩種參與者類型的 `(company_id, principal_type, principal_id)` 進行權限檢查
- 這避免了單獨的 authz 程式碼路徑並保持行為一致

角色層：

- `instance_admin`：部署範圍內的管理員，可以存取/管理所有公司和使用者-公司存取映射
- `company_member`：僅限公司範圍的權限

核心補助金：

1. `agents:create`
2. `users:invite`
3. `users:manage_permissions`
4. `tasks:assign`
5. `tasks:assign_scope`（組織約束委託）
6. `joins:approve`（批准/拒絕人工和智能體加入請求）

附加行為規則：

- 實例管理員可以提升/降級實例管理員並管理跨公司的使用者訪問
- 董事會級使用者可以管理他們控制的公司內部的公司撥款
- 非管理主體只能在明確的授權範圍內行事
- 分配檢查適用於智能體和人工分配者

## 命令鏈範圍設計

初步方法：

- 將分配範圍表示為組織層級結構中的允許規則
- 例：
  - `subtree:<agentId>`（可指派到該管理器子樹）
  - `exclude:<agentId>`（無法指派給受保護的角色，例如執行長）

執行：

- 解決目標受讓人組織職位
- 在賦值突變之前評估允許/拒絕範圍規則
- 對於超出範圍的分配返回 `403`

## 邀請與註冊流程

1. 授權使用者建立一個 `company_join` 邀請共享鏈接，可選預設值 + 到期時間。
2. 系統發送包含一次性令牌的邀請 URL。
3. 邀請登陸頁面呈現兩條路徑：`Join as human`或`Join as agent`（以`allowed_join_types`為準）。
4. 請求者選擇加入路徑並提交所需資料。
5. 提交消耗token並建立`pending_approval`加入請求（尚未存取）。
6. 加入請求擷取評論元資料：

- 人類：經過驗證的電子郵件
- 兩者：來源IP
- 智能體：建議的智能體元數據7. 公司管理員/實例管理員審核請求並批准或拒絕。
8. 批准後：

- 人類：啟動 `company_membership` 並申請權限授予
- 智能體：建立智能體記錄並啟用API-key索賠流程

9. 連結是一次性的，不能重複使用。
10. 邀請者/管理員可以在接受之前撤銷邀請。

安全規則：

- 儲存靜態雜湊的邀請令牌
- 一次性使用的令牌，有效期短
- 所有邀請生命週期事件均記錄在 `activity_log` 中
- 待批准的用戶在獲得批准之前無法讀取或更改任何公司數據

## 加入審批收件匣

- 加入請求會為符合資格的審核者（`joins:approve` 或管理員角色）產生收件匣警報
- 警報出現在以下兩者：
  - 全球/公司收件匣提要
  - 專用的待批准使用者介面
- 每個警報都包含內聯批准/拒絕操作（無需上下文切換）
- 警報有效負載必須包括：
  - 請求者電子郵件為 `request_type=human`
  - 來源IP
  - 請求類型（`human | agent`）

## 人類收件匣和智能體到人類的委託

行為：

- 當政策允許時，智能體可以將任務分配給人類
- 人們在收件匣檢視中看到指派的任務（包括在本機信任模式下）
- 評論和狀態轉換遵循相同的問題生命週期守衛

## 智能體程式加入路徑（透過統一邀請連結）

1. 授權用戶分享1個`company_join`邀請連結（`allowed_join_types`包含`agent`）。
2. 智能體操作員打開鏈接，選擇`Join as agent`，並提交加入有效負載（名稱/角色/適配器元資料）。
3. 系統建立`pending_approval`智能體程式加入請求並擷取來源IP。
4. 審批者看到收件匣中的警報並批准或拒絕。
5. 批准後，伺服器建立智能體記錄並鑄造一個長期存在的 API 金鑰。
6. API 密鑰透過帶有明確「立即儲存」指令的安全聲明流程僅顯示一次。

長期代幣政策：

- 預設為長期可撤銷 API 金鑰（靜態儲存的雜湊值）
- 僅顯示一次明文金鑰
- 支援從管理介面立即撤銷/重新生成
- 稍後可以選擇新增過期/輪換策略，而無需更改加入流程

API 補充（建議）：

- `GET /companies/:companyId/inbox`（人類參與者範圍僅限於自身；包括任務項目+授權時的待定加入批准警報）
- `POST /companies/:companyId/issues/:issueId/assign-user`
- `POST /companies/:companyId/invites`
- `GET /invites/:token`（邀請登陸酬載為`allowed_join_types`）
- `POST /invites/:token/accept`（主體包括`requestType=human|agent`和請求元資料）
- `POST /invites/:inviteId/revoke`
- `GET /companies/:companyId/join-requests?status=pending_approval&requestType=human|agent`
- `POST /companies/:companyId/join-requests/:requestId/approve`
- `POST /companies/:companyId/join-requests/:requestId/reject`
- `POST /join-requests/:requestId/claim-api-key`（僅限已批准的智能體請求）
- `GET /companies/:companyId/members`（返回人類和智能體委託人）
- `PATCH /companies/:companyId/members/:memberId/permissions`
- `POST /admin/users/:userId/promote-instance-admin`
- `POST /admin/users/:userId/demote-instance-admin`
- `PUT /admin/users/:userId/company-access`（為使用者設定可存取的公司）
- `GET /admin/users/:userId/company-access`

## 本機模式使用者體驗策略- 無需登入提示或帳戶設置
- 自動設定本地隱式董事會使用者以進行審計歸因
- 本地操作員仍然可以使用實例設定和公司設定作為有效的實例管理員
- 邀請、加入審核和權限管理 UI 在本機模式下可用
- 智能體加入預計在本地模式下進行，包括建立邀請連結和批准加入請求
- 公共/不受信任的網路入口超出了 V1 本地模式的範圍

## 此模型中的雲端智能體

- 雲端智能體繼續透過`agent_api_keys`進行身份驗證
- 同一公司的邊界檢查仍然是強制性的
- 智能體分配人工任務的能力是受權限限制的，而不是隱含的

## 實例設定介面

此計劃引入了實例層級問題（例如引導狀態、實例管理員、邀請預設值和令牌策略）。目前還沒有專門的 UI 介面。

V1方法：

- 為實例管理員新增最小的 `Instance Settings` 頁面
- 在 API + CLI (`paperclipai configure` / `paperclipai onboard`) 中公開關鍵實例設置
- 在主 UI 中顯示唯讀實例狀態指示器，直到存在完整的設定 UX

## 實施階段

## 第一階段：模式與護欄

- 新增明確部署模式配置（`local_trusted | cloud_hosted`）
- 加強啟動安全檢查和健康可見性
- 為本地隱式董事會實施參與者解析
- 將本地隱式董事會參與者對應到實例管理授權上下文
- 在健康/配置表面新增引導狀態訊號（`ready | bootstrap_pending`）
- 新增最小實例設定 API/CLI 表面和唯讀 UI 指示器

## 第二階段：人類身分和會員資格

- 為使用者/會員資格/邀請新增架構+遷移
- 用於雲端模式的有線身份驗證中間件
- 新增會員查找和公司訪問檢查
- 實施更好的身份驗證電子郵件/密碼流程（無電子郵件驗證）
- 實施第一管理員引導邀請指令和板載集成
- 透過 `pending_approval` 加入請求實現一次性分享連結邀請接受流程

## 第 3 階段：權限和分配範圍

- 新增共享主體授予模型和執行助手
- 新增分配命令鏈範圍檢查 APIs
- 新增禁止分配的測試（例如，不能分配給CEO）
- 新增實例管理員升級/降級和全域公司存取管理APIs
- 新增 `joins:approve` 人員和智能體加入核准的權限檢查

## 第 4 階段：邀請工作流程- 統一`company_join`邀請創建/登陸/接受/撤銷端點
- 使用審核元資料（適用時的電子郵件、IP）加入請求批准/拒絕端點
- 一次性令牌安全和撤銷語義
- 用於邀請管理、待定加入批准和會員權限的使用者介面
- 為待處理的加入請求產生收件匣警報
- 確保在 `cloud_hosted` 和 `local_trusted` 中啟用邀請和批准 UX

## 第 5 階段：人工收件匣 + 任務分配更新

- 為人類用戶擴展問題受讓人模型
- 收件匣 API 和 UI：
  - 任務分配
  - 帶有內聯批准/拒絕操作的待定加入批准警報
- 智能體到人員的分配流程以及策略檢查

## 第 6 階段：智能體自加入和令牌聲明

- 在統一邀請登陸頁面新增智能體加入路徑
- 捕獲智能體加入請求和管理員批准流程
- 審核後建立一次性API-key索賠流程（顯示一次）

## 驗收標準

1. `local_trusted` 無需登入即可啟動並立即顯示棋盤UI。
2. `local_trusted` 在 V1 中未公開選購的人工登入 UX。
3. `local_trusted` 本地隱式參與者可以管理實例設定、邀請連結、加入批准和權限授予。
4. `cloud_hosted` 未設定授權無法啟動。
5. `cloud_hosted` 中的請求在沒有經過身份驗證的參與者的情況下不能改變資料。
6. 如果不存在初始管理員，應用程式將使用 CLI 命令顯示引導指令。
7. 當開機掛起時，`pnpm paperclipai onboard` 輸出 CEO 入職邀請 URL。
8. 一個 `company_join` 連結透過邀請登陸頁面上的加入類型選擇支援人工和座席加入。
9. V1 中的邀請傳送僅是複製連結（無內建電子郵件傳送）。
10. 共享連結接受建立待處理的加入請求；它不授予立即存取權限。
11. 待處理的加入請求顯示為具有內聯核准/拒絕操作的收件匣警報。
12. 管理員審核檢視包括決策前的加入元資料（適用時的人工電子郵件、來源 IP 以及智能體請求的智能體元資料）。
13. 只有批准的加入請求才能解鎖存取權限：

- 人力：活躍的公司會員+許可證授予
- 智能體：智能體創建+API-key索賠資格14. 智能體註冊遵循相同的連結 -> 待批准 -> 批准流程。
15. 經批准的智能體可以僅聲明一次長期存在的 API 密鑰，並具有純文字顯示一次語義。
16. 智能體 API 金鑰在 V1 中預設是無限期的，並且可由管理員撤銷/重新產生。
17. V1（僅環回本機伺服器）不支援 `local_trusted` 的公共/不受信任入口。
18. 一名用戶可以擁有多家公司的會員資格。
19. 實例管理員可以將其他使用者提升為實例管理員。
20. 實例管理員可以管理每個使用者可以存取哪些公司。
21. 可以透過一個共享授權系統向每個成員主體（人或智能體）授予/撤銷權限。
22. 分配範圍可防止層級外或受保護角色的分配。
23. 只有在允許的情況下，智能體才能將任務分配給人類。
24. 人們可以在收件匣中查看指派的任務，並根據權限執行這些任務。
25. 所有新突變均在公司範圍內並記錄在 `activity_log` 中。

## V1 決策（已鎖定）

1. `local_trusted` V1版本將不支援登入UX；僅隱含本地董事會演員。
2. 權限使用規範化共享表：`principal_permission_grants` 和範圍授權。
3. V1版本僅透過複製連結方式發送邀請（無內建郵件發送功能）。
4. 引導邀請建立應僅需要本機 shell 存取（僅 CLI 路徑，無 HTTP 引導端點）。
5. 審核審核僅顯示來源IP； V1 中沒有 GeoIP/國家查找。
6. V1 中智能體 API-key 的生命週期預設為無限期，具有明確撤銷/重新產生控制。
7. 本機模式透過隱含本機實例管理參與者保留完整的管理/設定/邀請功能。
8. 本地模式的公共/不受信任入口超出了 V1 的範圍； V1 中沒有 `--dangerous-agent-ingress`。