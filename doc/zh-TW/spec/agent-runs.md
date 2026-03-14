# 智能體運行子系統規範

狀態：草案
日期：2026-02-17
受眾：產品+工程
範圍：智能體執行運行時、適配器協定、喚醒編排和即時狀態傳遞

## 1. 文檔角色

該規範定義了 Paperclip 如何在保持運行時不可知的情況下實際運行智能體程式。

- `doc/SPEC-implementation.md` 仍為 V1 基線合約。
- 本文檔添加了智能體執行的具體子系統詳細信息，包括本地 CLI 適配器、運行時狀態持久性、喚醒調度和瀏覽器即時更新。
- 如果此文件與程式碼中的目前執行時間行為衝突，則此文件是即將實施的目標行為。

## 2. 捕獲的意圖（來自請求）

本規範明確保留了以下意圖：

1. Paperclip 與適配器無關。關鍵是協議，而不是特定的運行時。
2. 我們仍然需要預設的內建程式來使系統立即可用。
3. 前兩個內建函數是 `claude-local` 和 `codex-local`。
4. 這些適配器直接在主機上執行本機 CLI，未進行沙盒處理。
5. 智能體程式配置包括工作目錄和初始/預設提示。
6. 心跳運行配置的適配器進程，Paperclip 管理生命週期，並在退出時 Paperclip 解析 JSON 輸出並更新狀態。
7. 必須保留會話 ID 和令牌使用情況，以便稍後可以恢復心跳。
8. 適配器應支援狀態更新（簡訊+顏色）和可選的流日誌。
9. UI應該支援提示模板「pills」用於變數插入。
10. CLI 錯誤必須在 UI 中完整（或盡可能）可見。
11. 狀態變更必須透過伺服器推送在任務和智能體視圖之間即時更新。
12. 喚醒觸發器應由心跳/喚醒服務集中，至少具有：
   - 定時器間隔
   - 任務分配喚醒
   - 明確 ping/請求

## 3. 目標與非目標

### 3.1 目標

1. 定義支援多個運行時的穩定適配器協定。
2. 為 Claude CLI 和 Codex CLI 提供生產可用的本地適配器。
3. 保留適配器執行時間狀態（會話 ID、令牌/成本使用情況、最後的錯誤）。
4. 將喚醒決策和排隊集中到一項服務。
5. 向瀏覽器提供即時運行/任務/智能體更新。
6. 支援特定於部署的完整日誌存儲，而不會使 Postgres 膨脹。
7. 保留公司範圍和現有的治理不變性。

### 3.2 非目標（針對此子系統階段）

1. 跨多個主機的分散式執行工作者。
2. 第三方適配器市場/插件SDK。
3. 為不排放成本的供應商提供完善的成本計算。
4. 超越基本保留的長期日誌歸檔策略。

## 4. 基準與差距（截至 2026 年 2 月 17 日）

目前程式碼已經有：- `agents` 與 `adapterType` + `adapterConfig`。
- `heartbeat_runs` 具有基本狀態追蹤功能。
- 進程內 `heartbeatService` 呼叫 `process` 和 `http`。
- 活动运行的取消端点。

该规范目前存在的差距：

1. 會話恢復沒有持久的每個智能體程式運行時狀態。
2. 無佇列/喚醒抽象化（呼叫是立即的）。
3. 無分配觸發或定時器觸發的集中喚醒。
4. 沒有到瀏覽器的 websocket/SSE 推送路徑。
5. 沒有持久的運行事件時間軸或外部完整日誌儲存合約。
6. Claude/Codex 會話和使用提取沒有類型化的本地適配器合約。
7. 智能體設定中沒有提示模板變數/藥丸系統。
8. 沒有用於完整運行日誌儲存（磁碟/物件儲存/等）的部署感知適配器。

## 5. 架構概述

该子系统引入了六个协作组件：

1. `Adapter Registry`
   - 将 `adapter_type` 映射到实现。
   - 公开功能元数据和配置验证。

2. `Wakeup Coordinator`
   - 所有喚醒的單一入口點（`timer`、`assignment`、`on_demand`、`automation`）。
   - 應用重複資料刪除/合併和佇列規則。

3. `Run Executor`
   - 請求排隊喚醒。
   - 创建 `heartbeat_runs`。
   - 生成/监视本地适配器的子进程。
   - 处理超时/取消/优雅杀死。

4. `Runtime State Store`
   - 保留每個智能體程式的可恢復適配器狀態。
   - 保留運行使用摘要和輕量級運行事件時間表。

5. `Run Log Store`
   - 透過可插拔儲存適配器保留完整的標準輸出/標準錯誤流。
   - 傳回穩定的 `logRef` 用於檢索（本機路徑、物件鍵或資料庫參考）。

6. `Realtime Event Hub`
   - 透過 websocket 發布運行/智能體/任務更新。
   - 支持企业选择性订阅。

控制流程（快乐路径）：

1. 觸發器到達（`timer`、`assignment`、`on_demand` 或 `automation`）。
2. 唤醒协调器排队/合并唤醒请求。
3. 執行者宣告請求，建立運行行，標記智能體`running`。
4. 適配器執行，發出狀態/日誌/使用事件。
5. 完整日誌流至`RunLogStore`；元資料/事件被儲存到資料庫並推送到 websocket 訂閱者。
6. 行程退出，輸出解析器更新運行結果+執行時間狀態。
7. 智能體返回`idle`或`error`；使用者介面即時更新。

## 6.智能體运行协议（版本`agent-run/v1`）

該協議與運行時無關並且由所有適配器實現。

```ts
type RunOutcome = "succeeded" | "failed" | "cancelled" | "timed_out";
type StatusColor = "neutral" | "blue" | "green" | "yellow" | "red";

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cachedOutputTokens?: number;
}

interface AdapterInvokeInput {
  protocolVersion: "agent-run/v1";
  companyId: string;
  agentId: string;
  runId: string;
  wakeupSource: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  cwd: string;
  prompt: string;
  adapterConfig: Record<string, unknown>;
  runtimeState: Record<string, unknown>;
  env: Record<string, string>;
  timeoutSec: number;
}

interface AdapterHooks {
  status?: (update: { message: string; color?: StatusColor }) => Promise<void>;
  log?: (event: { stream: "stdout" | "stderr" | "system"; chunk: string }) => Promise<void>;
  usage?: (usage: TokenUsage) => Promise<void>;
  event?: (eventType: string, payload: Record<string, unknown>) => Promise<void>;
}

interface AdapterInvokeResult {
  outcome: RunOutcome;
  exitCode: number | null;
  errorMessage?: string | null;
  summary?: string | null;
  sessionId?: string | null;
  usage?: TokenUsage | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  runtimeStatePatch?: Record<string, unknown>;
  rawResult?: Record<string, unknown> | null;
}

interface AgentRunAdapter {
  type: string;
  protocolVersion: "agent-run/v1";
  capabilities: {
    resumableSession: boolean;
    statusUpdates: boolean;
    logStreaming: boolean;
    tokenUsage: boolean;
  };
  validateConfig(config: unknown): { ok: true } | { ok: false; errors: string[] };
  invoke(input: AdapterInvokeInput, hooks: AdapterHooks, signal: AbortSignal): Promise<AdapterInvokeResult>;
}
```

### 6.1 所需行為1. `validateConfig` 在儲存或呼叫之前運行。
2. `invoke` 對於給定的配置+運行時狀態+提示必須是確定性的。
3. Adapter不能直接修改DB；它僅透過結果/事件傳回資料。
4. 適配器必須發出足夠的上下文才能偵錯錯誤。
5. 如果 `invoke` 拋出，執行程式將記錄為 `failed` 運行並捕獲錯誤文字。

### 6.2 可選行為

適配器可能會省略狀態/日誌掛鉤。若省略，運行時仍會發出系統生命週期狀態（`queued`、`running`、`finished`）。

### 6.3 運行日誌儲存協議

完整運行日誌由單獨的可插入儲存（而不是智能體適配器）管理。

```ts
type RunLogStoreType = "local_file" | "object_store" | "postgres";

interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string; // opaque provider reference (path, key, uri, row id)
}

interface RunLogStore {
  begin(input: { companyId: string; agentId: string; runId: string }): Promise<RunLogHandle>;
  append(
    handle: RunLogHandle,
    event: { stream: "stdout" | "stderr" | "system"; chunk: string; ts: string },
  ): Promise<void>;
  finalize(
    handle: RunLogHandle,
    summary: { bytes: number; sha256?: string; compressed: boolean },
  ): Promise<void>;
  read(
    handle: RunLogHandle,
    opts?: { offset?: number; limitBytes?: number },
  ): Promise<{ content: string; nextOffset?: number }>;
  delete?(handle: RunLogHandle): Promise<void>;
}
```

V1 部署預設值：

1. 開發/本地預設：`local_file`（寫入`data/run-logs/...`）。
2. 雲端/無伺服器預設：`object_store`（相容於S3/R2/GCS）。
3. 可選後備：`postgres`，具有嚴格的尺寸上限。

### 6.4 適配器身分和相容性

對於 V1 部署，適配器標識是明確的：

- `claude_local`
- `codex_local`
- `process`（通用現有行為）
- `http`（通用現有行為）

`claude_local` 和 `codex_local` 不是任意 `process` 的包裝器；它們是具有已知解析器/恢復語義的類型適配器。

## 7. 內建適配器（第一階段）

## 7.1 `claude-local`

直接運行本地`claude` CLI。

### 配置

```json
{
  "cwd": "/absolute/or/relative/path",
  "promptTemplate": "You are agent {{agent.id}} ...",
  "model": "optional-model-id",
  "maxTurnsPerRun": 80,
  "dangerouslySkipPermissions": true,
  "env": {"KEY": "VALUE"},
  "extraArgs": [],
  "timeoutSec": 1800,
  "graceSec": 20
}
```

### 呼叫

- 基本指令：`claude --print <prompt> --output-format json`
- 恢復：當運作狀態有會話ID時加入`--resume <sessionId>`
- 非沙盒模式：啟用時新增 `--dangerously-skip-permissions`

### 輸出解析

1. 解析stdout JSON 物件。
2. 提取`session_id`作為簡歷。
3. 提取使用字段：
   - `usage.input_tokens`
   - `usage.cache_read_input_tokens`（如果存在）
   - `usage.output_tokens`
4. 提取 `total_cost_usd`（如果存在）。
5. 非零退出時：仍然嘗試解析；如果解析成功，則保留提取的狀態並標記運行失敗，除非適配器明確報告成功。

## 7.2 `codex-local`

直接運行本地`codex` CLI。

### 配置

```json
{
  "cwd": "/absolute/or/relative/path",
  "promptTemplate": "You are agent {{agent.id}} ...",
  "model": "optional-model-id",
  "search": false,
  "dangerouslyBypassApprovalsAndSandbox": true,
  "env": {"KEY": "VALUE"},
  "extraArgs": [],
  "timeoutSec": 1800,
  "graceSec": 20
}
```

### 呼叫

- 基本指令：`codex exec --json <prompt>`
- 履歷表：`codex exec --json resume <sessionId> <prompt>`
- 非沙盒模式：啟用時新增 `--dangerously-bypass-approvals-and-sandbox`
- 可選搜尋方式：新增`--search`

### 輸出解析

Codex 發出 JSONL 事件。逐行解析並擷取：

1. `thread.started.thread_id` -> 會話ID
2. `item.completed`，其中項目類型為 `agent_message` -> 輸出文本
3. `turn.completed.usage`：
   - `input_tokens`
   - `cached_input_tokens`
   - `output_tokens`

Codex JSONL 目前可能不包含成本；儲存令牌使用情況並將成本保留為空/未知（除非可用）。

## 7.3 常見本機適配器進程處理

兩個本地適配器必須：1.使用`spawn(command, args, { shell: false, stdio: "pipe" })`。
2. 捕捉流塊中的 stdout/stderr 並轉送到 `RunLogStore`。
3. 在記憶體中維護 DB 診斷欄位的滾動 stdout/stderr 尾部摘錄。
4. 向 websocket 訂閱者發送即時日誌事件（可選的限制/區塊）。
5. 支援優雅取消：`SIGTERM`，`graceSec`之後再`SIGKILL`。
6. 使用轉接器 `timeoutSec` 強制逾時。
7. 返回退出代碼+解析結果+診斷stderr。

## 8. 心跳與喚醒協調器

## 8.1 喚醒來源

支持的來源：

1. `timer`：每個智能體的定期心跳。
2. `assignment`：問題已指派/重新指派給智能體。
3. `on_demand`：明確喚醒請求路徑（板/手動點擊或 API ping）。
4. `automation`：非互動式喚醒路徑（外部回呼或內部系統自動化）。

## 8.2 中央API

所有來源均呼叫一項內部服務：

```ts
enqueueWakeup({
  companyId,
  agentId,
  source,
  triggerDetail, // optional: manual|ping|callback|system
  reason,
  payload,
  requestedBy,
  idempotencyKey?
})
```

沒有來源直接呼叫適配器。

## 8.3 佇列語義

1. 每個智能體程式的最大活動運行數仍為 `1`。
2. 如果智能體程式已經有 `queued`/`running` 運作：
   - 合併重複喚醒
   - 增加`coalescedCount`
   - 保留最新的原因/來源元數據
3. 佇列由資料庫支援以確保重新啟動安全性。
4. 協調器使用`requested_at`的FIFO，優先權可選：
   - `on_demand` > `assignment` > `timer`/`automation`

## 8.4 智能體心跳策略字段

智能體級控制平面設定（不是特定於適配器的）：

```json
{
  "heartbeat": {
    "enabled": true,
    "intervalSec": 300,
    "wakeOnAssignment": true,
    "wakeOnOnDemand": true,
    "wakeOnAutomation": true,
    "cooldownSec": 10
  }
}
```

預設值：

- `enabled: true`
- `intervalSec: null`（在明確設定之前沒有計時器）或產品預設值 `300`（如果全域需要）
- `wakeOnAssignment: true`
- `wakeOnOnDemand: true`
- `wakeOnAutomation: true`

## 8.5 觸發器積分規則

1. 計時器檢查在伺服器工作執行緒間隔上運行，並將到期智能體程式排隊。
2. 當受讓人發生變化並且目標智能體具有 `wakeOnAssignment=true` 時，問題分配突變會使喚醒入隊。
3. 當 `wakeOnOnDemand=true` 時，按需端點將喚醒與 `source=on_demand` 和 `triggerDetail=manual|ping` 排隊。
4. 當 `wakeOnAutomation=true` 時，回呼/系統自動使用 `source=automation` 和 `triggerDetail=callback|system` 排隊喚醒。
5. 暫停/終止的智能體不會收到新的喚醒。
6. 硬性預算停止的智能體不會收到新的喚醒。

## 9. 持久化模型

所有表格仍屬於公司範圍。

## 9.0 對 `agents` 的更改

1. 擴充 `adapter_type` 域以包含 `claude_local` 和 `codex_local`（以及現有的 `process`、`http`）。
2. 將 `adapter_config` 保留為適配器擁有的配置（CLI 標誌、cwd、提示模板、env 覆蓋）。
3. 控制面調度策略新增`runtime_config` jsonb：
   - 心跳啟用/間隔
   - 任務喚醒
   - 按需喚醒
   - 自動化喚醒
   - 冷卻時間

這種分離使適配器配置與運行時無關，同時允許心跳服務應用一致的調度邏輯。## 9.1 新表：`agent_runtime_state`

每個智能體程式一行用於聚合運行時計數器和舊版相容性。

- `agent_id` uuid PK FK `agents.id`
- `company_id` uuid fk 不為空
- `adapter_type` 文字不為空
- `session_id` 文字為空
- `state_json` jsonb 不為 null 預設 `{}`
- `last_run_id` uuid fk `heartbeat_runs.id` null
- `last_run_status` 文字為空
- `total_input_tokens` bigint 不為 null 預設 `0`
- `total_output_tokens` bigint 不為 null 預設 `0`
- `total_cached_input_tokens` bigint 不為 null 預設 `0`
- `total_cost_cents` bigint 不為 null 預設 `0`
- `last_error` 文字為空
- `updated_at` 時間戳記不為空

不變：每個智能體程式只有一個運行時狀態行。

## 9.1.1 新表：`agent_task_sessions`

每個 `(company_id, agent_id, adapter_type, task_key)` 一行用於可恢復會話狀態。

- `id` uuid pk
- `company_id` uuid fk 不為空
- `agent_id` uuid fk 不為空
- `adapter_type` 文字不為空
- `task_key` 文字不為空
- `session_params_json` jsonb null（適配器定義的形狀）
- `session_display_id` 文字為空（用於 UI/偵錯）
- `last_run_id` uuid fk `heartbeat_runs.id` null
- `last_error` 文字為空
- `created_at` 時間戳記不為空
- `updated_at` 時間戳記不為空

不變：唯一的`(company_id, agent_id, adapter_type, task_key)`。

## 9.2 新表：`agent_wakeup_requests`

佇列+喚醒審核。

- `id` uuid pk
- `company_id` uuid fk 不為空
- `agent_id` uuid fk 不為空
- `source` 文字不為空 (`timer|assignment|on_demand|automation`)
- `trigger_detail` 文字為空 (`manual|ping|callback|system`)
- `reason` 文字為空
- `payload` jsonb 空
- `status` 文字不為空 (`queued|claimed|coalesced|skipped|completed|failed|cancelled`)
- `coalesced_count` int 不為 null 預設 `0`
- `requested_by_actor_type` 文字為空 (`user|agent|system`)
- `requested_by_actor_id` 文字為空
- `idempotency_key` 文字為空
- `run_id` uuid fk `heartbeat_runs.id` null
- `requested_at` 時間戳記不為空
- `claimed_at` 時間戳空
- `finished_at` 時間戳空
- `error` 文字為空

## 9.3 新表：`heartbeat_run_events`

僅附加每次運行的輕量級事件時間軸（沒有完整的原始日誌區塊）。

- `id` bigserial pk
- `company_id` uuid fk 不為空
- `run_id` uuid fk `heartbeat_runs.id` 不為空
- `agent_id` uuid fk `agents.id` 不為空
- `seq` int 不為空
- `event_type` 文字不為空 (`lifecycle|status|usage|error|structured`)
- `stream` 文字為空 (`system|stdout|stderr`)（僅匯總事件，而非完整流塊）
- `level` 文本為空 (`info|warn|error`)
- `color` 文字為空
- `message` 文字為空
- `payload` jsonb 空
- `created_at` 時間戳記不為空

## 9.4 `heartbeat_runs` 的更改

新增結果和診斷所需的欄位：- `wakeup_request_id` uuid fk `agent_wakeup_requests.id` null
- `exit_code` int null
- `signal` 文字為空
- `usage_json` jsonb 空
- `result_json` jsonb 空
- `session_id_before` 文字為空
- `session_id_after` 文字為空
- `log_store` 文字為空 (`local_file|object_store|postgres`)
- `log_ref` 文字為空（不透明的提供者引用；路徑/鍵/uri/行 ID）
- `log_bytes` bigint null
- `log_sha256` 文字為空
- `log_compressed` 布林值不為 null 預設 false
- `stderr_excerpt` 文字為空
- `stdout_excerpt` 文字為空
- `error_code` 文字為空

這使得每次運行的診斷都可查詢，而無需在 Postgres 中儲存完整日誌。

## 9.5 日誌儲存適配器配置

運行時日誌儲存是部署配置的（預設不是每個智能體程式）。

```json
{
  "runLogStore": {
    "type": "local_file | object_store | postgres",
    "basePath": "./data/run-logs",
    "bucket": "paperclip-run-logs",
    "prefix": "runs/",
    "compress": true,
    "maxInlineExcerptBytes": 32768
  }
}
```

規則：

1. `log_ref` 在 API 邊界上必須是不透明且提供者中立的。
2. UI/API 不得採用本機檔案系統語意。
3. 提供者特定的秘密/憑證保留在伺服器配置中，而不是智能體配置中。

## 10.提示模板和藥丸系統

## 10.1 範本格式

- 小鬍子風格佔位符：`{{path.to.value}}`
- 不執行任意程式碼。
- 儲存時未知變數 = 驗證錯誤。

## 10.2 初始變數目錄

- `company.id`
- `company.name`
- `agent.id`
- `agent.name`
- `agent.role`
- `agent.title`
- `run.id`
- `run.source`
- `run.startedAt`
- `heartbeat.reason`
- `paperclip.skill`（共享Paperclip技能文字區塊）
- `credentials.apiBaseUrl`
- `credentials.apiKey`（可選，敏感）

## 10.3 提示字段

1. `promptTemplate`
   - 每次喚醒時使用（首次運行和恢復運行）。
   - 可包含跑步源/原因藥丸。

## 10.4 使用者介面要求

1. 智能體設定/編輯表單包括帶有藥丸插入的提示編輯器。
2. 變數顯示為可點擊的藥丸，以便快速插入。
3. 保存時間驗證顯示未知/缺失變數。
4. 敏感藥片（`credentials.*`）顯示明確的警告標誌。

## 10.5 憑證的安全說明

1. 為了最初的簡單性，允許提示中的憑證，但不鼓勵。
2. 首選傳輸是在運行時注入的環境變數 (`PAPERCLIP_*`)。
3. 提示預覽和日誌必須編輯敏感值。

## 11. 即時狀態傳遞

## 11.1 運輸

主要傳輸：每個公司的 websocket 通道。

- 端點：`GET /api/companies/:companyId/events/ws`
- 驗證：董事會會議或智能體 API 金鑰（公司綁定）

## 11.2 事件信封

```json
{
  "eventId": "uuid-or-monotonic-id",
  "companyId": "uuid",
  "type": "heartbeat.run.status",
  "entityType": "heartbeat_run",
  "entityId": "uuid",
  "occurredAt": "2026-02-17T12:00:00Z",
  "payload": {}
}
```

## 11.3 所需的事件類型

1. `agent.status.changed`
2. `heartbeat.run.queued`
3. `heartbeat.run.started`
4. `heartbeat.run.status`（短彩+留言更新）
5. `heartbeat.run.log`（可選的即時塊流；由`RunLogStore`處理完全持久性）
6. `heartbeat.run.finished`
7. `issue.updated`
8. `issue.comment.created`
9. `activity.appended`

## 11.4 使用者介面行為1. 智能體程式詳細資料視圖更新即時運行時間軸。
2. 任務板反映座席活動的分配/狀態/評論更改，無需刷新。
3. 組織/智能體清單即時反映狀態變化。
4. 如果 websocket 斷開連接，客戶端將回退到短輪詢，直到重新連接。

## 12. 錯誤處理與診斷

## 12.1 錯誤類別

- `adapter_not_installed`
- `invalid_working_directory`
- `spawn_failed`
- `timeout`
- `cancelled`
- `nonzero_exit`
- `output_parse_error`
- `resume_session_invalid`
- `budget_blocked`

## 12.2 日誌記錄要求

1. 將完整的 stdout/stderr 流保留到設定的 `RunLogStore`。
2. 僅在 Postgres 中保留輕量級運行元資料/事件（`heartbeat_runs`、`heartbeat_run_events`）。
3. 在 Postgres 中保留有界的 `stdout_excerpt` 和 `stderr_excerpt` 以進行快速診斷。
4. 當摘錄受到限制時，明確標記截斷。
5. 編輯日誌、摘錄和 Websocket 有效負載中的機密。

## 12.3 日誌保留與生命週期

1. `RunLogStore` 保留期可透過部署進行設定（例如 7/30/90 天）。
2. Postgres 運行元資料的壽命可能比完整日誌物件的壽命長。
3. 刪除/修剪作業必須安全地處理孤立的元資料/日誌物件參考。
4. 如果完整日誌物件消失，API 仍傳回狀態為 `log_unavailable` 的元資料和摘錄。

## 12.4 重啟恢復

伺服器啟動時：

1. 尋找陳舊的 `queued`/`running` 運行。
2. 用`error_code=control_plane_restart`標記為`failed`。
3. 將受影響的非暫停/非終止智能體設定為 `error`（或依策略設定為 `idle`）。
4. 將復原事件傳送到 websocket 和活動日誌。

## 13. API 表面變化

## 13.1 新的/更新的端點

1. `POST /agents/:agentId/wakeup`
   - 將喚醒與來源/原因排隊
2. `POST /agents/:agentId/heartbeat/invoke`
   - 向後相容喚醒別名 API
3. `GET /agents/:agentId/runtime-state`
   - 僅板調試視圖
4. `GET /agents/:agentId/task-sessions`
   - 任務範圍適配器會話的僅董事會列表
5. `POST /agents/:agentId/runtime-state/reset-session`
   - 清除智能體程式的所有任務會話，或在提供 `taskKey` 時清除一個任務會話
6. `GET /heartbeat-runs/:runId/events?afterSeq=:n`
   - 取得持久的輕量級時間線
7. `GET /heartbeat-runs/:runId/log`
   - 透過 `RunLogStore` 讀取完整日誌流（或物件儲存的重定向/預簽名 URL）
8. `GET /api/companies/:companyId/events/ws`
   - 網路套接字流

## 13.2 突變記錄

所有喚醒/運行狀態突變必須建立 `activity_log` 條目：

- `wakeup.requested`
- `wakeup.coalesced`
- `heartbeat.started`
- `heartbeat.finished`
- `heartbeat.failed`
- `heartbeat.cancelled`
- `runtime_state.updated`

## 14.心跳服務實施方案

## 第 1 階段：合約與架構

1. 新增新的資料庫表格/欄位（`agent_runtime_state`、`agent_wakeup_requests`、`heartbeat_run_events`、`heartbeat_runs.log_*` 欄位）。
2. 增加`RunLogStore`介面及設定接線。
3. 新增共用類型/常數/驗證器。
4. 在遷移過程中保持現有路由的功能。

## 第 2 階段：喚醒協調器1. 實作資料庫支援的喚醒佇列。
2. 將呼叫/喚醒路由轉換為使用 `source=on_demand` 和適當的 `triggerDetail` 排隊。
3. 新增工作循環以聲明並執行排隊喚醒。

## 第 3 階段：本機適配器

1. 實現`claude-local`適配器。
2. 實現`codex-local`適配器。
3. 解析並保留會話 ID 和令牌使用情況。
4. 線路取消/逾時/寬限行為。

## 第四階段：即時推送

1. 實施公司websocket hub。
2. 發布運行/智能體/問題事件。
3. 更新UI頁面訂閱和失效/更新相關數據。

## 第 5 階段：提示藥丸和配置 UX

1. 新增帶有提示範本的適配器特定配置編輯器。
2. 加入藥丸插入和變數驗證。
3. 新增敏感變數警告和密文。

## 第 6 階段：強化

1. 新增故障/重啟恢復掃描。
2. 新增元資料/完整日誌保留策略和修剪作業。
3. 新增喚醒觸發器和即時更新的整合/e2e 覆蓋範圍。

## 15. 驗收標準

1. `claude-local` 或 `codex-local` 的智能體程式可以執行、退出並儲存運行結果。
2. 會話參數會依任務範圍保留，並在相同任務復原時自動重複使用。
3. 令牌使用情況會在每次運行時保持不變，並根據智能體運行時狀態進行累積。
4. 定時器、分配、按需和自動喚醒均透過一個協調器進行排隊。
5. 暫停/終止中斷正在運行的本機程序並防止新的喚醒。
6. 瀏覽器接收運行狀態/日誌和任務/智能體程式變更的即時 Websocket 更新。
7. 失敗的運行會在 UI 中公開豐富的 CLI 診斷信息，並可立即提供摘錄，並可通過 `RunLogStore` 檢索完整日誌。
8. 所有行動均在公司範圍內且可審計。

## 16. 開放性問題

1. 定時器預設應該是`null`（關閉直到啟用）還是`300` 秒？
2. 完整日誌物件與 Postgres 元資料的預設保留策略應該是什麼？
3. 預設情況下，提示範本中是否應允許智能體 API 憑證，還是需要明確選擇加入切換？
4. websocket 應該是唯一的即時通道，還是應該為更簡單的客戶端公開 SSE？