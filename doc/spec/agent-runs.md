# Agent Runs 子系统规格说明

状态：草稿
日期：2026-02-17
受众：产品 + 工程
范围：Agent 执行运行时、适配器协议、唤醒编排及实时状态推送

## 1. 文档定位

本规格说明定义了 Paperclip 如何在保持运行时无关性的前提下实际运行 agents。

- `doc/SPEC-implementation.md` 仍为 V1 基线合约。
- 本文档为 agent 执行新增了具体的子系统细节，包括本地 CLI 适配器、运行时状态持久化、唤醒调度以及浏览器实时更新。
- 若本文档与代码中的当前运行时行为存在冲突，以本文档为即将实现的目标行为。

## 2. 意图记录（来自需求）

以下意图在本规格说明中被明确保留：

1. Paperclip 与适配器无关。核心是一套协议，而非特定的运行时。
2. 仍需提供默认内置项，使系统能立即投入使用。
3. 前两个内置项为 `claude-local` 和 `codex-local`。
4. 这些适配器直接在宿主机上运行本地 CLI，无沙盒隔离。
5. Agent 配置包含工作目录和初始/默认提示词。
6. Heartbeat 运行已配置的适配器进程，Paperclip 管理其生命周期，进程退出后 Paperclip 解析 JSON 输出并更新状态。
7. Session ID 和 token 用量必须持久化，以便后续 heartbeat 可以恢复。
8. 适配器应支持状态更新（短消息 + 颜色）以及可选的流式日志。
9. UI 应支持提示词模板"pills"用于变量插入。
10. CLI 错误必须在 UI 中完整显示（或尽可能多地显示）。
11. 状态变更必须通过服务端推送在任务视图和 agent 视图中实时更新。
12. 唤醒触发器应由一个 heartbeat/wakeup 服务集中管理，至少支持：
   - 定时器间隔
   - 任务分配时唤醒
   - 显式 ping/请求

## 3. 目标与非目标

### 3.1 目标

1. 定义一套支持多运行时的稳定适配器协议。
2. 交付可用于生产环境的 Claude CLI 和 Codex CLI 本地适配器。
3. 持久化适配器运行时状态（session ID、token/费用用量、最近错误）。
4. 在单一服务中集中管理唤醒决策与队列。
5. 向浏览器提供运行/任务/agent 的实时更新。
6. 在不使 Postgres 膨胀的前提下，支持特定部署的完整日志存储。
7. 保留公司作用域及现有治理不变量。

### 3.2 非目标（本子系统阶段）

1. 跨多主机的分布式执行 worker。
2. 第三方适配器市场/插件 SDK。
3. 对不发出费用数据的 provider 进行完美费用核算。
4. 超出基本保留期的长期日志归档策略。

## 4. 基线与差距（截至 2026-02-17）

当前代码已具备：

- 带有 `adapterType` + `adapterConfig` 的 `agents`。
- 带有基本状态跟踪的 `heartbeat_runs`。
- 进程内 `heartbeatService`，可调用 `process` 和 `http`。
- 活跃运行的取消端点。

本规格说明所解决的当前差距：

1. 缺少用于 session 恢复的按 agent 持久化运行时状态。
2. 缺少队列/唤醒抽象（调用为即时触发）。
3. 缺少分配触发或定时器触发的集中式唤醒。
4. 缺少向浏览器的 websocket/SSE 推送路径。
5. 缺少持久化的运行事件时间线或外部完整日志存储合约。
6. 缺少用于 Claude/Codex session 和用量提取的类型化本地适配器合约。
7. Agent 设置中缺少提示词模板变量/pill 系统。
8. 缺少感知部署环境的完整运行日志存储适配器（磁盘/对象存储等）。

## 5. 架构概览

该子系统引入六个协同组件：

1. `Adapter Registry`（适配器注册表）
   - 将 `adapter_type` 映射到具体实现。
   - 暴露能力元数据及配置校验。

2. `Wakeup Coordinator`（唤醒协调器）
   - 所有唤醒的单一入口（`timer`、`assignment`、`on_demand`、`automation`）。
   - 应用去重/合并与队列规则。

3. `Run Executor`（运行执行器）
   - 认领队列中的唤醒请求。
   - 创建 `heartbeat_runs`。
   - 为本地适配器派生/监控子进程。
   - 处理超时/取消/优雅终止。

4. `Runtime State Store`（运行时状态存储）
   - 按 agent 持久化可恢复的适配器状态。
   - 持久化运行用量摘要及轻量运行事件时间线。

5. `Run Log Store`（运行日志存储）
   - 通过可插拔存储适配器持久化完整的 stdout/stderr 流。
   - 返回用于检索的稳定 `logRef`（本地路径、对象键或 DB 引用）。

6. `Realtime Event Hub`（实时事件中心）
   - 通过 websocket 发布运行/agent/任务更新。
   - 支持按公司进行选择性订阅。

控制流（正常路径）：

1. 触发器到达（`timer`、`assignment`、`on_demand` 或 `automation`）。
2. 唤醒协调器将唤醒请求入队/合并。
3. 执行器认领请求，创建运行行，将 agent 标记为 `running`。
4. 适配器执行，发出 status/log/usage 事件。
5. 完整日志流入 `RunLogStore`；元数据/事件持久化到 DB 并推送至 websocket 订阅者。
6. 进程退出，输出解析器更新运行结果 + 运行时状态。
7. Agent 返回 `idle` 或 `error`；UI 实时更新。

## 6. Agent 运行协议（版本 `agent-run/v1`）

本协议与运行时无关，由所有适配器实现。

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

### 6.1 必要行为

1. `validateConfig` 在保存或调用之前运行。
2. 对于给定的 config + 运行时状态 + 提示词，`invoke` 必须具有确定性。
3. 适配器不得直接修改 DB；它仅通过 result/events 返回数据。
4. 适配器必须输出足够的上下文以便错误可调试。
5. 若 `invoke` 抛出异常，执行器将运行记录为 `failed` 并捕获错误文本。

### 6.2 可选行为

适配器可以省略 status/log hooks。若省略，运行时仍会发出系统生命周期状态（`queued`、`running`、`finished`）。

### 6.3 运行日志存储协议

完整运行日志由独立的可插拔存储管理（而非由 agent 适配器管理）。

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

V1 部署默认值：

1. 开发/本地默认：`local_file`（写入 `data/run-logs/...`）。
2. 云/无服务器默认：`object_store`（兼容 S3/R2/GCS）。
3. 可选后备：带严格大小限制的 `postgres`。

### 6.4 适配器标识与兼容性

V1 发布时，适配器标识为显式：

- `claude_local`
- `codex_local`
- `process`（通用现有行为）
- `http`（通用现有行为）

`claude_local` 和 `codex_local` 不是对任意 `process` 的包装；它们是具有已知解析器/恢复语义的类型化适配器。

## 7. 内置适配器（第一阶段）

## 7.1 `claude-local`

直接运行本地 `claude` CLI。

### 配置

```json
{
  "cwd": "/absolute/or/relative/path",
  "promptTemplate": "You are agent {{agent.id}} ...",
  "model": "optional-model-id",
  "maxTurnsPerRun": 300,
  "dangerouslySkipPermissions": true,
  "env": {"KEY": "VALUE"},
  "extraArgs": [],
  "timeoutSec": 1800,
  "graceSec": 20
}
```

### 调用方式

- 基础命令：`claude --print <prompt> --output-format json`
- 恢复：当运行时状态包含 session ID 时添加 `--resume <sessionId>`
- 非沙盒模式：启用时添加 `--dangerously-skip-permissions`

### 输出解析

1. 解析 stdout JSON 对象。
2. 提取 `session_id` 用于恢复。
3. 提取用量字段：
   - `usage.input_tokens`
   - `usage.cache_read_input_tokens`（如存在）
   - `usage.output_tokens`
4. 存在时提取 `total_cost_usd`。
5. 非零退出时：仍尝试解析；若解析成功则保留提取的状态，并将运行标记为失败，除非适配器明确报告成功。

## 7.2 `codex-local`

直接运行本地 `codex` CLI。

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

### 调用方式

- 基础命令：`codex exec --json <prompt>`
- 恢复形式：`codex exec --json resume <sessionId> <prompt>`
- 非沙盒模式：启用时添加 `--dangerously-bypass-approvals-and-sandbox`
- 可选搜索模式：添加 `--search`

### 输出解析

Codex 输出 JSONL 事件。逐行解析并提取：

1. `thread.started.thread_id` -> session ID
2. `item.completed`（item 类型为 `agent_message`）-> 输出文本
3. `turn.completed.usage`：
   - `input_tokens`
   - `cached_input_tokens`
   - `output_tokens`

Codex JSONL 当前可能不包含费用；存储 token 用量，除非有数据否则费用留为 null/未知。

## 7.3 本地适配器通用进程处理

两个本地适配器均须：

1. 使用 `spawn(command, args, { shell: false, stdio: "pipe" })`。
2. 以流块形式捕获 stdout/stderr 并转发至 `RunLogStore`。
3. 在内存中维护滚动的 stdout/stderr 尾部摘录，用于 DB 诊断字段。
4. 向 websocket 订阅者发出实时日志事件（可选择节流/分块）。
5. 支持优雅取消：`SIGTERM`，然后在 `graceSec` 后发送 `SIGKILL`。
6. 使用适配器 `timeoutSec` 强制执行超时。
7. 返回退出码 + 解析结果 + 诊断 stderr。

## 8. Heartbeat 与唤醒协调器

## 8.1 唤醒来源

支持的来源：

1. `timer`：按 agent 周期性 heartbeat。
2. `assignment`：issue 被分配/重新分配给 agent。
3. `on_demand`：显式唤醒请求路径（看板/手动点击或 API ping）。
4. `automation`：非交互式唤醒路径（外部回调或内部系统自动化）。

## 8.2 中央 API

所有来源调用同一个内部服务：

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

所有来源均不直接调用适配器。

## 8.3 队列语义

1. 每个 agent 的最大活跃运行数保持为 `1`。
2. 若 agent 已有 `queued`/`running` 运行：
   - 合并重复唤醒
   - 递增 `coalescedCount`
   - 保留最新的 reason/source 元数据
3. 队列有 DB 支撑以保证重启安全性。
4. 协调器按 `requested_at` 使用 FIFO，带可选优先级：
   - `on_demand` > `assignment` > `timer`/`automation`

## 8.4 Agent heartbeat 策略字段

Agent 级控制平面设置（非适配器专属）：

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

默认值：

- `enabled: true`
- `intervalSec: null`（显式设置前无定时器），若全局需要则产品默认为 `300`
- `wakeOnAssignment: true`
- `wakeOnOnDemand: true`
- `wakeOnAutomation: true`

## 8.5 触发器集成规则

1. 定时器检查在服务端 worker 间隔运行，并将到期的 agents 加入队列。
2. Issue 分配变更时，若目标 agent 的 `wakeOnAssignment=true`，则将唤醒入队。
3. 按需端点在 `wakeOnOnDemand=true` 时，以 `source=on_demand` 和 `triggerDetail=manual|ping` 将唤醒入队。
4. 回调/系统自动化在 `wakeOnAutomation=true` 时，以 `source=automation` 和 `triggerDetail=callback|system` 将唤醒入队。
5. 已暂停/已终止的 agents 不接收新唤醒。
6. 已因预算强制停止的 agents 不接收新唤醒。

## 9. 持久化模型

所有表均保持公司作用域。

## 9.0 对 `agents` 的变更

1. 将 `adapter_type` 域扩展为包含 `claude_local` 和 `codex_local`（与现有的 `process`、`http` 并列）。
2. 保持 `adapter_config` 作为适配器自有配置（CLI 标志、cwd、提示词模板、env 覆盖）。
3. 为控制平面调度策略添加 `runtime_config` jsonb：
   - heartbeat 启用/间隔
   - wake-on-assignment
   - wake-on-on-demand
   - wake-on-automation
   - 冷却时间

此分离使适配器配置保持运行时无关性，同时允许 heartbeat 服务应用一致的调度逻辑。

## 9.1 新表：`agent_runtime_state`

每个 agent 一行，用于聚合运行时计数器和向后兼容。

- `agent_id` uuid pk fk `agents.id`
- `company_id` uuid fk not null
- `adapter_type` text not null
- `session_id` text null
- `state_json` jsonb not null default `{}`
- `last_run_id` uuid fk `heartbeat_runs.id` null
- `last_run_status` text null
- `total_input_tokens` bigint not null default `0`
- `total_output_tokens` bigint not null default `0`
- `total_cached_input_tokens` bigint not null default `0`
- `total_cost_cents` bigint not null default `0`
- `last_error` text null
- `updated_at` timestamptz not null

不变量：每个 agent 恰好一行运行时状态。

## 9.1.1 新表：`agent_task_sessions`

每个 `(company_id, agent_id, adapter_type, task_key)` 一行，用于可恢复的 session 状态。

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk not null
- `adapter_type` text not null
- `task_key` text not null
- `session_params_json` jsonb null（适配器定义的结构）
- `session_display_id` text null（用于 UI/调试）
- `last_run_id` uuid fk `heartbeat_runs.id` null
- `last_error` text null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

不变量：`(company_id, agent_id, adapter_type, task_key)` 唯一。

## 9.2 新表：`agent_wakeup_requests`

唤醒的队列 + 审计。

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk not null
- `source` text not null（`timer|assignment|on_demand|automation`）
- `trigger_detail` text null（`manual|ping|callback|system`）
- `reason` text null
- `payload` jsonb null
- `status` text not null（`queued|claimed|coalesced|skipped|completed|failed|cancelled`）
- `coalesced_count` int not null default `0`
- `requested_by_actor_type` text null（`user|agent|system`）
- `requested_by_actor_id` text null
- `idempotency_key` text null
- `run_id` uuid fk `heartbeat_runs.id` null
- `requested_at` timestamptz not null
- `claimed_at` timestamptz null
- `finished_at` timestamptz null
- `error` text null

## 9.3 新表：`heartbeat_run_events`

按运行追加的轻量事件时间线（不含完整原始日志块）。

- `id` bigserial pk
- `company_id` uuid fk not null
- `run_id` uuid fk `heartbeat_runs.id` not null
- `agent_id` uuid fk `agents.id` not null
- `seq` int not null
- `event_type` text not null（`lifecycle|status|usage|error|structured`）
- `stream` text null（`system|stdout|stderr`）（仅摘要事件，非完整流块）
- `level` text null（`info|warn|error`）
- `color` text null
- `message` text null
- `payload` jsonb null
- `created_at` timestamptz not null

## 9.4 对 `heartbeat_runs` 的变更

添加结果与诊断所需的字段：

- `wakeup_request_id` uuid fk `agent_wakeup_requests.id` null
- `exit_code` int null
- `signal` text null
- `usage_json` jsonb null
- `result_json` jsonb null
- `session_id_before` text null
- `session_id_after` text null
- `log_store` text null（`local_file|object_store|postgres`）
- `log_ref` text null（不透明 provider 引用；path/key/uri/row id）
- `log_bytes` bigint null
- `log_sha256` text null
- `log_compressed` boolean not null default false
- `stderr_excerpt` text null
- `stdout_excerpt` text null
- `error_code` text null

这使得按运行的诊断信息可查询，同时无需在 Postgres 中存储完整日志。

## 9.5 日志存储适配器配置

运行时日志存储由部署配置（默认非按 agent）。

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

规则：

1. 在 API 边界处，`log_ref` 必须是不透明且 provider 中立的。
2. UI/API 不得假设本地文件系统语义。
3. Provider 专属的密钥/凭据保留在服务端配置中，绝不放入 agent 配置。

## 10. 提示词模板与 Pill 系统

## 10.1 模板格式

- Mustache 风格占位符：`{{path.to.value}}`
- 不允许任意代码执行。
- 保存时遇到未知变量 = 校验错误。

## 10.2 初始变量目录

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
- `paperclip.skill`（共享的 Paperclip skill 文本块）
- `credentials.apiBaseUrl`
- `credentials.apiKey`（可选，敏感）

## 10.3 提示词字段

1. `promptTemplate`
   - 每次唤醒时使用（首次运行及恢复运行）。
   - 可包含运行来源/原因 pills。

## 10.4 UI 要求

1. Agent 设置/编辑表单包含带 pill 插入功能的提示词编辑器。
2. 变量显示为可点击的 pills 以便快速插入。
3. 保存时校验提示未知/缺失的变量。
4. 敏感 pills（`credentials.*`）显示明确的警告徽章。

## 10.5 凭据安全说明

1. 提示词中包含凭据在初期为方便而允许，但不建议使用。
2. 首选传输方式是在运行时注入的 env vars（`PAPERCLIP_*`）。
3. 提示词预览和日志必须对敏感值进行脱敏处理。

## 11. 实时状态推送

## 11.1 传输方式

主要传输方式：按公司的 websocket 通道。

- 端点：`GET /api/companies/:companyId/events/ws`
- 认证：看板 session 或 agent API key（公司绑定）

## 11.2 Event envelope

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

## 11.3 必需的事件类型

1. `agent.status.changed`
2. `heartbeat.run.queued`
3. `heartbeat.run.started`
4. `heartbeat.run.status`（短颜色+消息更新）
5. `heartbeat.run.log`（可选的实时块流；完整持久化由 `RunLogStore` 处理）
6. `heartbeat.run.finished`
7. `issue.updated`
8. `issue.comment.created`
9. `activity.appended`

## 11.4 UI 行为

1. Agent 详情视图实时更新运行时间线。
2. 任务看板无需刷新即可反映来自 agent 活动的分配/状态/评论变更。
3. 组织/agent 列表实时反映状态变更。
4. 若 websocket 断开，客户端回退到短轮询直到重新连接。

## 12. 错误处理与诊断

## 12.1 错误类型

- `adapter_not_installed`
- `invalid_working_directory`
- `spawn_failed`
- `timeout`
- `cancelled`
- `nonzero_exit`
- `output_parse_error`
- `resume_session_invalid`
- `budget_blocked`

## 12.2 日志记录要求

1. 将完整的 stdout/stderr 流持久化到已配置的 `RunLogStore`。
2. 仅将轻量运行元数据/事件持久化到 Postgres（`heartbeat_runs`、`heartbeat_run_events`）。
3. 将有界的 `stdout_excerpt` 和 `stderr_excerpt` 持久化到 Postgres 以便快速诊断。
4. 摘录被截断时明确标记。
5. 从日志、摘录和 websocket 负载中脱敏密钥。

## 12.3 日志保留与生命周期

1. `RunLogStore` 保留期可按部署配置（例如 7/30/90 天）。
2. Postgres 运行元数据可在完整日志对象之后继续存在。
3. 删除/清理任务必须安全处理孤立的元数据/日志对象引用。
4. 若完整日志对象已删除，API 仍返回元数据和摘录，状态为 `log_unavailable`。

## 12.4 重启恢复

服务端启动时：

1. 查找过期的 `queued`/`running` 运行。
2. 以 `error_code=control_plane_restart` 标记为 `failed`。
3. 将受影响的非暂停/非终止 agents 设置为 `error`（或按策略为 `idle`）。
4. 向 websocket 和活动日志发出恢复事件。

## 13. API 接口变更

## 13.1 新增/更新端点

1. `POST /agents/:agentId/wakeup`
   - 以 source/reason 将唤醒入队
2. `POST /agents/:agentId/heartbeat/invoke`
   - 向唤醒 API 的向后兼容别名
3. `GET /agents/:agentId/runtime-state`
   - 仅看板可访问的调试视图
4. `GET /agents/:agentId/task-sessions`
   - 仅看板可访问的任务范围适配器 session 列表
5. `POST /agents/:agentId/runtime-state/reset-session`
   - 清除 agent 的所有任务 session，或在提供 `taskKey` 时清除单个
6. `GET /heartbeat-runs/:runId/events?afterSeq=:n`
   - 获取已持久化的轻量时间线
7. `GET /heartbeat-runs/:runId/log`
   - 通过 `RunLogStore` 读取完整日志流（或对象存储的重定向/预签名 URL）
8. `GET /api/companies/:companyId/events/ws`
   - websocket 流

## 13.2 Mutation logging

All wakeup/run state mutations must create `activity_log` entries:

- `wakeup.requested`
- `wakeup.coalesced`
- `heartbeat.started`
- `heartbeat.finished`
- `heartbeat.failed`
- `heartbeat.cancelled`
- `runtime_state.updated`

## 14. Heartbeat Service Implementation Plan

## Phase 1: Contracts and schema

1. Add new DB tables/columns (`agent_runtime_state`, `agent_wakeup_requests`, `heartbeat_run_events`, `heartbeat_runs.log_*` fields).
2. Add `RunLogStore` interface and configuration wiring.
3. Add shared types/constants/validators.
4. Keep existing routes functional during migration.

## Phase 2: Wakeup coordinator

1. Implement DB-backed wakeup queue.
2. Convert invoke/wake routes to enqueue with `source=on_demand` and appropriate `triggerDetail`.
3. Add worker loop to claim and execute queued wakeups.

## Phase 3: Local adapters

1. Implement `claude-local` adapter.
2. Implement `codex-local` adapter.
3. Parse and persist session IDs and token usage.
4. Wire cancel/timeout/grace behavior.

## Phase 4: Realtime push

1. Implement company websocket hub.
2. Publish run/agent/issue events.
3. Update UI pages to subscribe and invalidate/update relevant data.

## Phase 5: Prompt pills and config UX

1. Add adapter-specific config editor with prompt templates.
2. Add pill insertion and variable validation.
3. Add sensitive-variable warnings and redaction.

## Phase 6: Hardening

1. Add failure/restart recovery sweeps.
2. Add metadata/full-log retention policies and pruning jobs.
3. Add integration/e2e coverage for wakeup triggers and live updates.

## 15. Acceptance Criteria

1. Agent with `claude-local` or `codex-local` can run, exit, and persist run result.
2. Session parameters are persisted per task scope and reused automatically for same-task resumes.
3. Token usage is persisted per run and accumulated per agent runtime state.
4. Timer, assignment, on-demand, and automation wakeups all enqueue through one coordinator.
5. Pause/terminate interrupts running local process and prevents new wakeups.
6. Browser receives live websocket updates for run status/logs and task/agent changes.
7. Failed runs expose rich CLI diagnostics in UI with excerpts immediately available and full log retrievable via `RunLogStore`.
8. All actions remain company-scoped and auditable.

## 16. Open Questions

1. Should timer default be `null` (off until enabled) or `300` seconds by default?
2. What should the default retention policy be for full log objects vs Postgres metadata?
3. Should agent API credentials be allowed in prompt templates by default, or require explicit opt-in toggle?
4. Should websocket be the only realtime channel, or should we also expose SSE for simpler clients?
