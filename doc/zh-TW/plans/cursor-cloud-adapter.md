# Cursor 雲端智能體適配器 — 技術方案

## 概述

本文檔定義了 Paperclip 適配器的 V1 設計，該適配器整合了
Cursor 後台智能體程式透過 Cursor REST API。

主要參考資料：

- https://docs.cursor.com/background-agent/api/overview
- https://docs.cursor.com/background-agent/api
- https://docs.cursor.com/background-agent/api/webhooks

與 `claude_local` 和 `codex_local` 不同，此適配器不是本地子進程。
它是一個遠端編排適配器，具有：

1. HTTP 的啟動/跟進
2. 盡可能進行 webhook 驅動的狀態更新
3. 輪詢可靠性的後備方案
4. 為 Paperclip UI/CLI 合成標準輸出事件

## V1 關鍵決策

1. **授權Cursor API**使用`Authorization: Bearer <CURSOR_API_KEY>`。
2. **回呼 URL** 必須可由 Cursor 虛擬機器公開存取：
   - 本地：Tailscale URL
   - prod: 公用伺服器 URL
3. ** Paperclip 的智能體回呼驗證**使用引導交換流程（提示中沒有長期存在的 Paperclip 金鑰）。
4. **Webhooks 是 V1**，輪詢仍然是後備方案。
5. **技能交付**是從 Paperclip 端點按需獲取，而不是完整的 SKILL.md 提示注入。

---

## Cursor API 參考（目前）

基本網址：`https://api.cursor.com`

身份驗證標頭：

- `Authorization: Bearer <CURSOR_API_KEY>`

核心端點：

|端點|方法|目的|
|---|---|---|
| `/v0/agents` |發佈 |推出智能體|
| `/v0/agents/{id}` |取得 |智能體狀態 |
| `/v0/agents/{id}/conversation` |取得 |對話歷史 |
| `/v0/agents/{id}/followup` |發佈 |後續提示|
| `/v0/agents/{id}/stop` |發布 |停止/暫停正在運行的智能體 |
| `/v0/models` |取得 |建議型號清單|
| `/v0/me` |取得 | API 金鑰元資料 |
| `/v0/repositories` |取得 |可存取的儲存庫（嚴格限制速率）|

適配器的狀態處理策略：

- 將 `CREATING` 和 `RUNNING` 視為非終端機。
- 將`FINISHED`視為成功終端機。
- 將`ERROR`視為故障端。
- 將未知的非活動狀態視為終端故障並在 `resultJson` 中保留原始狀態。

與 V1 相關的 Webhook 事實：

- Cursor 發出 `statusChange` webhooks。
- 終端 webhook 狀態包括 `ERROR` 和 `FINISHED`。
- Webhook 簽章使用 HMAC SHA256 (`X-Webhook-Signature: sha256=...`)。

操作限制：

- `/v0/repositories`：1 個請求/用戶/分鐘，30 個請求/用戶/小時。
- Cursor 後台智能體程式不支援 MCP。

---

## 套件結構

```
packages/adapters/cursor-cloud/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── api.ts
    ├── server/
    │   ├── index.ts
    │   ├── execute.ts
    │   ├── parse.ts
    │   ├── test.ts
    │   └── webhook.ts
    ├── ui/
    │   ├── index.ts
    │   ├── parse-stdout.ts
    │   └── build-config.ts
    └── cli/
        ├── index.ts
        └── format-event.ts
```

`package.json` 使用標準四個出口（`.`、`./server`、`./ui`、`./cli`）。

---

## API 用戶端 (`src/api.ts`)

`src/api.ts` 是 Cursor 端點的型別包裝器。

```ts
interface CursorClientConfig {
  apiKey: string;
  baseUrl?: string; // default https://api.cursor.com
}

interface CursorAgent {
  id: string;
  name: string;
  status: "CREATING" | "RUNNING" | "FINISHED" | "ERROR" | string;
  source: { repository: string; ref: string };
  target: {
    branchName?: string;
    prUrl?: string;
    url?: string;
    autoCreatePr?: boolean;
    openAsCursorGithubApp?: boolean;
    skipReviewerRequest?: boolean;
  };
  summary?: string;
  createdAt: string;
}
```

客戶要求：

- 對所有請求發送 `Authorization: Bearer ...`
- 拋出帶有 `status` 的類型 `CursorApiError`、已解析的正文和請求上下文
- 保留原始未知欄位以在錯誤元資料中進行偵錯

---## 適配器配置合約 (`src/index.ts`)

```ts
export const type = "cursor_cloud";
export const label = "Cursor Cloud Agent";
```

V1 配置字段：

- `repository`（必填）：GitHub 倉庫 URL
- `ref`（可選，預設`main`）
- `model`（可選，允許為空=自動）
- `autoCreatePr`（可選，預設`false`）
- `branchName`（選購）
- `promptTemplate`
- `pollIntervalSec`（可選，預設`10`）
- `timeoutSec`（可選，預設`0`）
- `graceSec`（可選，預設`20`）
- `paperclipPublicUrl`（可選覆蓋；其他 `PAPERCLIP_PUBLIC_URL` 環境）
- `enableWebhooks`（可選，預設`true`）
- `env.CURSOR_API_KEY`（必需，secret_ref 首選）
- `env.CURSOR_WEBHOOK_SECRET`（如果是 `enableWebhooks=true`，則需要，最少 32）

重要：請勿將 Cursor 金鑰儲存在普通 `apiKey` 頂級欄位中。
使用 `adapterConfig.env`，以便現有秘密解析流支援秘密引用。

---

## Paperclip 回呼+認證流程（V1）

Cursor智能體程式遠端運行，因此我們不能像`PAPERCLIP_API_KEY`那樣注入本地環境。

### 公用網址

適配器必須按以下順序解析回呼基本 URL：

1. `adapterConfig.paperclipPublicUrl`
2. `process.env.PAPERCLIP_PUBLIC_URL`

如果為空，則 `testEnvironment` 和運行時執行失敗，並出現明顯錯誤。

### 引導交換

目標：避免將長期存在的 Paperclip 憑證放入提示文字中。

流程：

1. 在啟動/後續之前，Paperclip 鑄造一個一次性引導令牌，綁定到：
   - `agentId`
   - `companyId`
   - `runId`
   - 短 TTL（例如 10 分鐘）
2. 適配器僅包括：
   - `paperclipPublicUrl`
   - 交換端點路徑
   - 引導令牌
3. Cursor 智能體電話：
   - `POST /api/agent-auth/exchange`
4. Paperclip 驗證引導令牌並返回運轉範圍的承載 JWT。
5. Cursor 智能體程式將傳回的承載令牌用於所有 Paperclip API 通話。

這使得長期密鑰不會被提示並支援透過 TTL 進行乾淨撤銷。

---

## 技能交付策略（V1）

不要將完整的 SKILL.md 內容內聯到提示中。

相反：

1. 提示包含一條從 Paperclip 取得技能的緊湊指令。
2. 身份驗證交換後，智能體程式取得：
   - `GET /api/skills/index`
   - `GET /api/skills/paperclip`
   - `GET /api/skills/paperclip-create-agent` 需要時
3. Agent按需載入全技能內容。

好處：

- 避免迅速膨脹
- 保持技能文件集中更新
- 與本地適配器如何將技能公開為可發現的過程保持一致

---

## 執行流程（`src/server/execute.ts`）

### 第 1 步：解析配置和機密

- 透過 `asString/asBoolean/asNumber/parseObject` 解析適配器配置
- 解析`env.CURSOR_API_KEY`
- 解析`paperclipPublicUrl`
- 啟用 Webhook 時驗證 Webhook 機密

### 第 2 步：會話解決

會話標識為Cursor `agentId`（儲存在`sessionParams`中）。
僅當儲存庫相符時重複使用。

### 第 3 步：渲染提示像往常一樣渲染模板，然後附加一個緊湊的回調塊：

- 公開 Paperclip 網址
- 引導交換端點
- 引導令牌
- 技能指數終點
- 所需的運行頭行為

### 第 4 步：啟動/跟進

- 履歷：`POST /followup`
- 其他：`POST /agents`
- 啟用時包括 webhook 物件：
  - `url: <paperclipPublicUrl>/api/adapters/cursor-cloud/webhooks`
  - `secret: CURSOR_WEBHOOK_SECRET`

### 第 5 步：進度 + 完成

使用混合策略：

- webhook 事件是主要狀態訊號
- 輪詢是後備和轉錄來源（`/conversation`）

將合成事件傳送到標準輸出（`init`、`status`、`assistant`、`user`、`result`）。

完成邏輯：

- 成功：`status === FINISHED`
- 失敗：`status === ERROR` 或未知終端
- 超時：停止智能體，標記超時

### 步驟 6：結果映射

`AdapterExecutionResult`:

- `exitCode: 0` 成功，`1` 終端機失敗
- `errorMessage` 失敗/超時時填充
- `sessionParams: { agentId, repository }`
- `provider: "cursor"`
- `usage` 和 `costUsd`：不可用/空
- `resultJson`：包含原始狀態/目標/對話快照

還要確保在返回之前將 `result` 事件發送到 stdout。

---

## Webhook 處理（`src/server/webhook.ts` + 伺服器路由）

新增伺服器端點以接收 Cursor Webhook 傳送。

職責：

1. 驗證來自`X-Webhook-Signature`的HMAC簽章。
2. 透過`X-Webhook-ID`去重。
3. 驗證事件類型（`statusChange`）。
4. 透過 Cursor `agentId` 路由到活動的 Paperclip 運行上下文。
5. 附加 `heartbeat_run_events` 條目以進行審核/偵錯。
6. 更新記憶體中的運轉訊號，以便執行循環可以快速短路。

安全性：

- 拒絕無效簽名（`401`）
- 拒絕格式錯誤的有效負載（`400`）
- 堅持後總是很快返回(`2xx`)

---

## 環境測試（`src/server/test.ts`）

檢查：

1. `CURSOR_API_KEY` 存在
2. 透過`GET /v0/me`驗證金鑰有效性
3. 儲存庫已配置且 URL 形狀有效
4. 模型存在（若設定）透過`/v0/models`
5. `paperclipPublicUrl` 存在且可達形狀有效
6. 啟用 webhook 時，webhook 秘密存在/長度有效

由於嚴格的速率限制，透過 `/v0/repositories` 進行的儲存庫存取驗證應該是可選的。
僅當設定了顯式 `verifyRepositoryAccess` 選項時才使用警告等級檢查。

---

## 使用者介面 + CLI

### UI解析器(`src/ui/parse-stdout.ts`)

處理事件類型：

- `init`
- `status`
- `assistant`
- `user`
- `result`
- 後備 `stdout`

如果結果失敗，請設定 `isError=true` 並包含錯誤文字。

### 設定產生器 (`src/ui/build-config.ts`)

- 地圖 `CreateConfigValues.url -> repository`
- 保留環境綁定形狀（`plain`/`secret_ref`）
- 包含預設值（`pollIntervalSec`、`timeoutSec`、`graceSec`、`enableWebhooks`）

### 適配器欄位 (`ui/src/adapters/cursor-cloud/config-fields.tsx`)

新增控制：- 儲存庫
- 參考
- 型號
- 自動建立Pr
- 分行名稱
- 輪詢間隔
- 超時/寬限
- Paperclip公共 URL 覆蓋
- 啟用網路鉤子
- `CURSOR_API_KEY` 和 `CURSOR_WEBHOOK_SECRET` 的環境綁定

### CLI 格式化程式 (`src/cli/format-event.ts`)

與本地適配器類似地格式化合成事件。
清楚地突出顯示終端故障。

---

## 伺服器註冊和跨層合約同步

### 適配器註冊

- `server/src/adapters/registry.ts`
- `ui/src/adapters/registry.ts`
- `cli/src/adapters/registry.ts`

### 共享合約更新（必要）

- 將 `cursor_cloud` 加入 `packages/shared/src/constants.ts` (ZXQQ00141QQZ)
- 確保驗證者接受它（`packages/shared/src/validators/agent.ts`）
- 更新枚舉適配器名稱的 UI 標籤/地圖，包括：
  - `ui/src/components/agent-config-primitives.tsx`
  - `ui/src/components/AgentProperties.tsx`
  - `ui/src/pages/Agents.tsx`
- 考慮加入精靈支援適配器選擇 (`ui/src/components/OnboardingWizard.tsx`)

如果沒有這些更新，即使包代碼存在，建立/編輯流程也會拒絕新適配器。

---

## 取消語義

長輪詢 HTTP 適配器必須支援運作取消。

V1要求：

- 每次執行適配器呼叫時註冊一個取消處理程序
- `cancelRun` 應呼叫該處理程序（中止獲取/輪詢循環+可選的 Cursor 停止呼叫）

對於 Cursor，目前的僅處理取消映射本身是不夠的。

---

## 與`claude_local`的比較

|方面| `claude_local` | `cursor_cloud` |
|---|---|---|
|執行模型|本地子進程 |遠端 API |
|更新 | 流 json 標準輸出 | webhook + 輪詢 + 合成標準輸出 |
|會話 ID | Claude 會話 ID | Cursor 智能體編號 |
|技能交付 |本地技能dir注入|從 Paperclip 技能端點進行身份驗證的獲取 |
| Paperclip 授權 |注入本地運行 JWT 環境變數 |引導代幣交換 -> 運行 JWT |
|取消 |作業系統訊號 |中止輪詢 + Cursor 停止端點 |
|使用/成本|豐富| Cursor 未曝光 API |

---

## V1 限制

1. Cursor 不會在 API 回應中公開令牌/成本使用。
2. 對話流僅為文字（`user_message`/`assistant_message`）。
3. MCP/工具呼叫粒度不可用。
4. Webhooks 目前提供狀態變更事件，而不是完整的轉錄增量。

---

## 未來的增強

1. 當webhook可靠性高時，進一步降低輪詢頻率。
2. 從 Paperclip 上下文附加影像有效負載。
3. 在Paperclip UI中加入更豐富的PR元資料展示。
4. 新增用於偵錯的 webhook 重播 UI。

---

## 實施清單

### 適配器包- [ ] `packages/adapters/cursor-cloud/package.json` 出口有線
- [ ] `packages/adapters/cursor-cloud/tsconfig.json`
- [ ] `src/index.ts` 元資料+設定文檔
- [ ] `src/api.ts` 持有者身份驗證客戶端 + 輸入錯誤
- [ ] `src/server/execute.ts` 混合 webhook/投票編排
- [ ] `src/server/parse.ts` 流解析器 + 找不到偵測
- [ ] `src/server/test.ts` 環境診斷
- [ ] `src/server/webhook.ts` 簽章驗證+有效負載助手
- [ ] `src/server/index.ts` 匯出 + 會話編解碼器
- [ ] `src/ui/parse-stdout.ts`
- [ ] `src/ui/build-config.ts`
- [ ] `src/ui/index.ts`
- [ ] `src/cli/format-event.ts`
- [ ] `src/cli/index.ts`

### 應用程式集成

- [ ] 在 server/ui/cli 註冊表中註冊適配器
- [ ] 將 `cursor_cloud` 新增至共用適配器常數/驗證器
- [ ] 在 UI 表面新增適配器標籤
- [ ] 在伺服器上新增 Cursor webhook 路由 (`/api/adapters/cursor-cloud/webhooks`)
- [ ]新增認證交換路由(`/api/agent-auth/exchange`)
- [ ]新增技能服務路線（`/api/skills/index`、`/api/skills/:name`）
- [ ] 為非子進程適配器新增通用取消鉤子

### 測試

- [ ] api 用戶端驗證/錯誤映射
- [ ] 終端狀態映射（`FINISHED`、`ERROR`、未知終端）
- [ ] 會話編解碼器往返
- [ ] 配置建構器環境綁定處理
- [ ] webhook簽章驗證+重複資料刪除
- [ ] bootstrap 交換快樂路徑 + 過期/無效令牌

### 驗證

- [ ] `pnpm -r typecheck`
- [ ] `pnpm test:run`
- [ ] `pnpm build`
