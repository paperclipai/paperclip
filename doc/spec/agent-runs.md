# 智能体运行子系统规范

状态：草稿
日期：2026-02-17
读者：产品 + 工程
范围：智能体执行运行时、适配器协议、唤醒编排和实时状态传递

## 1. 文档角色

本规范定义 Paperclip 如何实际运行智能体，同时保持运行时无关性。

- `doc/SPEC-implementation.md` 仍然是 V1 基线合约。
- 本文档为智能体执行添加具体的子系统细节，包括本地 CLI 适配器、运行时状态持久化、唤醒调度和浏览器实时更新。
- 如果本文档与代码中的当前运行时行为冲突，本文档是即将实现的目标行为。

## 2. 捕获的意图（来自请求）

以下意图在本规范中被明确保留：

1. Paperclip 是适配器无关的。关键是协议，而非特定运行时。
2. 我们仍然需要默认内置适配器使系统立即可用。
3. 前两个内置适配器是 `claude-local` 和 `codex-local`。
4. 这些适配器直接在主机上运行本地 CLI，未沙箱化。
5. 智能体配置包括工作目录和初始/默认提示。
6. 心跳运行配置的适配器进程，Paperclip 管理生命周期，退出时 Paperclip 解析 JSON 输出并更新状态。
7. 会话 ID 和 Token 使用必须持久化，以便后续心跳可以恢复。
8. 适配器应支持状态更新（短消息 + 颜色）和可选的流式日志。
9. UI 应支持用于变量插入的提示模板"药丸"。
10. CLI 错误必须在 UI 中完整显示（或尽可能多地显示）。
11. 状态变化必须通过服务器推送在任务和智能体视图之间实时更新。
12. 唤醒触发器应由心跳/唤醒服务集中管理，至少包括：
    - 定时器间隔
    - 任务分配时唤醒
    - 显式 ping/请求

## 3. 目标和非目标

### 3.1 目标

1. 定义支持多个运行时的稳定适配器协议。
2. 为 Claude CLI 和 Codex CLI 交付可生产使用的本地适配器。
3. 持久化适配器运行时状态（会话 ID、Token/成本使用、最后错误）。
4. 在一个服务中集中唤醒决策和队列。
5. 向浏览器提供运行/任务/智能体的实时更新。
6. 支持部署特定的完整日志存储，而不膨胀 Postgres。
7. 保持公司范围和现有治理不变量。

### 3.2 非目标（此子系统阶段）

1. 跨多个主机的分布式执行工作器。
2. 第三方适配器市场/插件 SDK。
3. 不发出成本的提供商的完美成本核算。
4. 超出基本保留的长期日志存档策略。

## 4. 基线和差距（截至 2026-02-17）

当前代码已有：

- 带 `adapterType` + `adapterConfig` 的 `agents`。
- 带基本状态跟踪的 `heartbeat_runs`。
- 调用 `process` 和 `http` 的进程内 `heartbeatService`。
- 活跃运行的取消端点。

当前差距（本规范解决）：

1. 没有用于会话恢复的每智能体持久运行时状态。
2. 没有队列/唤醒抽象（调用是立即的）。
3. 没有分配触发或定时器触发的集中唤醒。
4. 没有到浏览器的 websocket/SSE 推送路径。
5. 没有持久化的运行事件时间线或外部完整日志存储合约。
6. 没有用于 Claude/Codex 会话和使用提取的类型化本地适配器合约。
7. 没有智能体设置中的提示模板变量/药丸系统。
8. 没有用于完整运行日志存储的部署感知适配器（磁盘/对象存储等）。

## 5. 架构概述

子系统引入六个协作组件：

1. `适配器注册表`
   - 将 `adapter_type` 映射到实现。
   - 暴露能力元数据和配置验证。

2. `唤醒协调器`
   - 所有唤醒的单一入口（`timer`、`assignment`、`on_demand`、`automation`）。
   - 应用去重/合并和队列规则。

3. `运行执行器`
   - 认领排队的唤醒。
   - 创建 `heartbeat_runs`。
   - 为本地适配器生成/监控子进程。
   - 处理超时/取消/优雅终止。

4. `运行时状态存储`
   - 持久化每个智能体的可恢复适配器状态。
   - 持久化运行使用摘要和轻量级运行事件时间线。

5. `运行日志存储`
   - 通过可插拔存储适配器持久化完整的 stdout/stderr 流。
   - 返回稳定的 `logRef` 用于检索（本地路径、对象键或数据库引用）。

6. `实时事件中心`
   - 通过 websocket 发布运行/智能体/任务更新。
   - 支持按公司的选择性订阅。

控制流程（正常路径）：

1. 触发器到达（`timer`、`assignment`、`on_demand` 或 `automation`）。
2. 唤醒协调器入队/合并唤醒请求。
3. 执行器认领请求，创建运行行，标记智能体 `running`。
4. 适配器执行，发出状态/日志/使用事件。
5. 完整日志流式传输到 `RunLogStore`；元数据/事件持久化到数据库并推送到 websocket 订阅者。
6. 进程退出，输出解析器更新运行结果 + 运行时状态。
7. 智能体返回 `idle` 或 `error`；UI 实时更新。

## 6. 智能体运行协议（版本 `agent-run/v1`）

该协议是运行时无关的，由所有适配器实现。

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

### 6.1 必需行为

1. `validateConfig` 在保存或调用前运行。
2. `invoke` 对于给定的配置 + 运行时状态 + 提示必须是确定性的。
3. 适配器不得直接修改数据库；它只通过结果/事件返回数据。
4. 适配器必须发出足够的上下文使错误可调试。
5. 如果 `invoke` 抛出异常，执行器将运行记录为 `failed` 并捕获错误文本。

### 6.2 可选行为

适配器可以省略状态/日志钩子。如果省略，运行时仍然发出系统生命周期状态（`queued`、`running`、`finished`）。

### 6.3 运行日志存储协议

完整的运行日志由单独的可插拔存储管理（不是由智能体适配器）。

```ts
type RunLogStoreType = "local_file" | "object_store" | "postgres";

interface RunLogHandle {
  store: RunLogStoreType;
  logRef: string; // 不透明的提供商引用（路径、键、URI、行 ID）
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
2. 云/无服务器默认：`object_store`（S3/R2/GCS 兼容）。
3. 可选回退：`postgres`，有严格的大小上限。

### 6.4 适配器身份和兼容性

V1 发布时，适配器身份是显式的：

- `claude_local`
- `codex_local`
- `process`（通用现有行为）
- `http`（通用现有行为）

`claude_local` 和 `codex_local` 不是任意 `process` 的封装；它们是具有已知解析器/恢复语义的类型化适配器。

## 7. 内置适配器（阶段 1）

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

### 调用

- 基础命令：`claude --print <prompt> --output-format json`
- 恢复：当运行时状态有会话 ID 时添加 `--resume <sessionId>`
- 非沙箱模式：启用时添加 `--dangerously-skip-permissions`

### 输出解析

1. 解析 stdout JSON 对象。
2. 提取 `session_id` 用于恢复。
3. 提取使用字段：
   - `usage.input_tokens`
   - `usage.cache_read_input_tokens`（如果存在）
   - `usage.output_tokens`
4. 当存在时提取 `total_cost_usd`。
5. 非零退出时：仍然尝试解析；如果解析成功，保留提取的状态并标记运行失败，除非适配器显式报告成功。

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

### 调用

- 基础命令：`codex exec --json <prompt>`
- 恢复形式：`codex exec --json resume <sessionId> <prompt>`
- 非沙箱模式：启用时添加 `--dangerously-bypass-approvals-and-sandbox`
- 可选搜索模式：添加 `--search`

### 输出解析

Codex 发出 JSONL 事件。逐行解析并提取：

1. `thread.started.thread_id` -> 会话 ID
2. `item.completed`，其中 item 类型是 `agent_message` -> 输出文本
3. `turn.completed.usage`：
   - `input_tokens`
   - `cached_input_tokens`
   - `output_tokens`

Codex JSONL 目前可能不包含成本；存储 Token 使用并将成本留为 null/未知，除非可用。

## 7.3 通用本地适配器进程处理

两个本地适配器都必须：

1. 使用 `spawn(command, args, { shell: false, stdio: "pipe" })`。
2. 以流块捕获 stdout/stderr 并转发到 `RunLogStore`。
3. 在内存中维护滚动的 stdout/stderr 尾部摘录用于数据库诊断字段。
4. 向 websocket 订阅者发出实时日志事件（可选择节流/分块）。
5. 支持优雅取消：`SIGTERM`，然后在 `graceSec` 后 `SIGKILL`。
6. 使用适配器 `timeoutSec` 强制超时。
7. 返回退出码 + 解析的结果 + 诊断 stderr。

## 8. 心跳和唤醒协调器

## 8.1 唤醒来源

支持的来源：

1. `timer`：每智能体的周期性心跳。
2. `assignment`：任务分配/重新分配给智能体。
3. `on_demand`：显式唤醒请求路径（董事会/手动点击或 API ping）。
4. `automation`：非交互式唤醒路径（外部回调或内部系统自动化）。

## 8.2 中央 API

所有来源调用一个内部服务：

```ts
enqueueWakeup({
  companyId,
  agentId,
  source,
  triggerDetail, // 可选：manual|ping|callback|system
  reason,
  payload,
  requestedBy,
  idempotencyKey?
})
```

没有来源直接调用适配器。

## 8.3 队列语义

1. 每智能体最大活跃运行保持为 `1`。
2. 如果智能体已有 `queued`/`running` 运行：
   - 合并重复唤醒
   - 递增 `coalescedCount`
   - 保留最新的原因/来源元数据
3. 队列由数据库支持以确保重启安全。
4. 协调器使用按 `requested_at` 的 FIFO，带可选优先级：
   - `on_demand` > `assignment` > `timer`/`automation`

## 8.4 智能体心跳策略字段

智能体级别的控制平面设置（非适配器特定）：

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
- `intervalSec: null`（在显式设置前不启用定时器）或者如果全局需要则产品默认 `300`
- `wakeOnAssignment: true`
- `wakeOnOnDemand: true`
- `wakeOnAutomation: true`

## 8.5 触发器集成规则

1. 定时器检查在服务器工作器间隔上运行并入队到期的智能体。
2. 任务分配变更在负责人变更时入队唤醒，前提是目标智能体 `wakeOnAssignment=true`。
3. 按需端点在 `wakeOnOnDemand=true` 时以 `source=on_demand` 和 `triggerDetail=manual|ping` 入队唤醒。
4. 回调/系统自动化在 `wakeOnAutomation=true` 时以 `source=automation` 和 `triggerDetail=callback|system` 入队唤醒。
5. 已暂停/已终止的智能体不接收新唤醒。
6. 硬预算停止的智能体不接收新唤醒。

## 9. 持久化模型

所有表保持公司范围。

## 9.0 `agents` 的变更

1. 扩展 `adapter_type` 域以包含 `claude_local` 和 `codex_local`（与现有的 `process`、`http` 并列）。
2. 保持 `adapter_config` 作为适配器拥有的配置（CLI 标志、cwd、提示模板、环境覆盖）。
3. 添加 `runtime_config` jsonb 用于控制平面调度策略：
   - 心跳启用/间隔
   - 分配时唤醒
   - 按需唤醒
   - 自动化唤醒
   - 冷却期

此分离保持适配器配置运行时无关，同时允许心跳服务应用一致的调度逻辑。

## 9.1 新表：`agent_runtime_state`

每智能体一行，用于聚合运行时计数器和遗留兼容性。

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

不变量：每个智能体恰好一行运行时状态。

## 9.1.1 新表：`agent_task_sessions`

每 `(company_id, agent_id, adapter_type, task_key)` 一行，用于可恢复会话状态。

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk not null
- `adapter_type` text not null
- `task_key` text not null
- `session_params_json` jsonb null（适配器定义的形状）
- `session_display_id` text null（用于 UI/调试）
- `last_run_id` uuid fk `heartbeat_runs.id` null
- `last_error` text null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

不变量：唯一 `(company_id, agent_id, adapter_type, task_key)`。

## 9.2 新表：`agent_wakeup_requests`

唤醒的队列 + 审计。

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk not null
- `source` text not null (`timer|assignment|on_demand|automation`)
- `trigger_detail` text null (`manual|ping|callback|system`)
- `reason` text null
- `payload` jsonb null
- `status` text not null (`queued|claimed|coalesced|skipped|completed|failed|cancelled`)
- `coalesced_count` int not null default `0`
- `requested_by_actor_type` text null (`user|agent|system`)
- `requested_by_actor_id` text null
- `idempotency_key` text null
- `run_id` uuid fk `heartbeat_runs.id` null
- `requested_at` timestamptz not null
- `claimed_at` timestamptz null
- `finished_at` timestamptz null
- `error` text null

## 9.3 新表：`heartbeat_run_events`

仅追加的每运行轻量级事件时间线（不包含完整的原始日志块）。

- `id` bigserial pk
- `company_id` uuid fk not null
- `run_id` uuid fk `heartbeat_runs.id` not null
- `agent_id` uuid fk `agents.id` not null
- `seq` int not null
- `event_type` text not null (`lifecycle|status|usage|error|structured`)
- `stream` text null (`system|stdout|stderr`)（仅摘要事件，不是完整流块）
- `level` text null (`info|warn|error`)
- `color` text null
- `message` text null
- `payload` jsonb null
- `created_at` timestamptz not null

## 9.4 `heartbeat_runs` 的变更

添加结果和诊断所需的字段：

- `wakeup_request_id` uuid fk `agent_wakeup_requests.id` null
- `exit_code` int null
- `signal` text null
- `usage_json` jsonb null
- `result_json` jsonb null
- `session_id_before` text null
- `session_id_after` text null
- `log_store` text null (`local_file|object_store|postgres`)
- `log_ref` text null（不透明的提供商引用；路径/键/URI/行 ID）
- `log_bytes` bigint null
- `log_sha256` text null
- `log_compressed` boolean not null default false
- `stderr_excerpt` text null
- `stdout_excerpt` text null
- `error_code` text null

这保持每运行诊断可查询，而不在 Postgres 中存储完整日志。

## 9.5 日志存储适配器配置

运行时日志存储由部署配置（默认不按智能体配置）。

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

1. `log_ref` 必须在 API 边界处不透明且提供商中立。
2. UI/API 不得假设本地文件系统语义。
3. 提供商特定的密钥/凭据保存在服务器配置中，永远不在智能体配置中。

## 10. 提示模板和药丸系统

## 10.1 模板格式

- Mustache 风格占位符：`{{path.to.value}}`
- 不执行任意代码。
- 保存时未知变量 = 验证错误。

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
- `paperclip.skill`（共享 Paperclip 技能文本块）
- `credentials.apiBaseUrl`
- `credentials.apiKey`（可选，敏感）

## 10.3 提示字段

1. `promptTemplate`
   - 每次唤醒时使用（首次运行和恢复运行）。
   - 可以包含运行来源/原因药丸。

## 10.4 UI 需求

1. 智能体设置/编辑表单包含带药丸插入的提示编辑器。
2. 变量显示为可点击的药丸，便于快速插入。
3. 保存时验证指示未知/缺失的变量。
4. 敏感药丸（`credentials.*`）显示显式警告徽章。

## 10.5 凭据安全说明

1. 提示中的凭据出于初始简单性被允许，但不推荐。
2. 首选传输方式是在运行时注入的环境变量（`PAPERCLIP_*`）。
3. 提示预览和日志必须脱敏敏感值。

## 11. 实时状态传递

## 11.1 传输

主要传输：每公司 websocket 通道。

- 端点：`GET /api/companies/:companyId/events/ws`
- 认证：董事会会话或智能体 API 密钥（公司绑定）

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

## 11.3 必需事件类型

1. `agent.status.changed`
2. `heartbeat.run.queued`
3. `heartbeat.run.started`
4. `heartbeat.run.status`（短颜色+消息更新）
5. `heartbeat.run.log`（可选实时块流；完整持久化由 `RunLogStore` 处理）
6. `heartbeat.run.finished`
7. `issue.updated`
8. `issue.comment.created`
9. `activity.appended`

## 11.4 UI 行为

1. 智能体详情视图实时更新运行时间线。
2. 任务看板反映智能体活动的分配/状态/评论变更，无需刷新。
3. 组织/智能体列表实时反映状态变更。
4. 如果 websocket 断开，客户端回退到短轮询直到重连。

## 12. 错误处理和诊断

## 12.1 错误类别

- `adapter_not_installed`
- `invalid_working_directory`
- `spawn_failed`
- `timeout`
- `cancelled`
- `nonzero_exit`
- `output_parse_error`
- `resume_session_invalid`
- `budget_blocked`

## 12.2 日志需求

1. 将完整 stdout/stderr 流持久化到配置的 `RunLogStore`。
2. 仅在 Postgres 中持久化轻量级运行元数据/事件（`heartbeat_runs`、`heartbeat_run_events`）。
3. 在 Postgres 中持久化有界的 `stdout_excerpt` 和 `stderr_excerpt` 用于快速诊断。
4. 当摘录被截断时显式标记。
5. 从日志、摘录和 websocket 负载中脱敏密钥。

## 12.3 日志保留和生命周期

1. `RunLogStore` 保留由部署配置（例如 7/30/90 天）。
2. Postgres 运行元数据可以比完整日志对象存活更久。
3. 删除/修剪作业必须安全处理孤立的元数据/日志对象引用。
4. 如果完整日志对象已消失，API 仍然返回元数据和摘录，带 `log_unavailable` 状态。

## 12.4 重启恢复

服务器启动时：

1. 查找陈旧的 `queued`/`running` 运行。
2. 标记为 `failed`，`error_code=control_plane_restart`。
3. 将受影响的非暂停/非终止智能体设为 `error`（或根据策略为 `idle`）。
4. 向 websocket 和活动日志发出恢复事件。

## 13. API 接口变更

## 13.1 新增/更新端点

1. `POST /agents/:agentId/wakeup`
   - 带来源/原因入队唤醒
2. `POST /agents/:agentId/heartbeat/invoke`
   - 向后兼容的唤醒 API 别名
3. `GET /agents/:agentId/runtime-state`
   - 仅董事会调试视图
4. `GET /agents/:agentId/task-sessions`
   - 仅董事会的任务范围适配器会话列表
5. `POST /agents/:agentId/runtime-state/reset-session`
   - 清除智能体的所有任务会话，或提供 `taskKey` 时清除一个
6. `GET /heartbeat-runs/:runId/events?afterSeq=:n`
   - 获取持久化的轻量级时间线
7. `GET /heartbeat-runs/:runId/log`
   - 通过 `RunLogStore` 读取完整日志流（或对象存储的重定向/预签名 URL）
8. `GET /api/companies/:companyId/events/ws`
   - websocket 流

## 13.2 变更日志

所有唤醒/运行状态变更必须创建 `activity_log` 条目：

- `wakeup.requested`
- `wakeup.coalesced`
- `heartbeat.started`
- `heartbeat.finished`
- `heartbeat.failed`
- `heartbeat.cancelled`
- `runtime_state.updated`

## 14. 心跳服务实现计划

## 阶段 1：合约和模式

1. 添加新的数据库表/列（`agent_runtime_state`、`agent_wakeup_requests`、`heartbeat_run_events`、`heartbeat_runs.log_*` 字段）。
2. 添加 `RunLogStore` 接口和配置连线。
3. 添加共享类型/常量/验证器。
4. 在迁移期间保持现有路由功能。

## 阶段 2：唤醒协调器

1. 实现数据库支持的唤醒队列。
2. 将调用/唤醒路由转换为以 `source=on_demand` 和适当的 `triggerDetail` 入队。
3. 添加工作器循环以认领和执行排队的唤醒。

## 阶段 3：本地适配器

1. 实现 `claude-local` 适配器。
2. 实现 `codex-local` 适配器。
3. 解析和持久化会话 ID 和 Token 使用。
4. 连线取消/超时/宽限行为。

## 阶段 4：实时推送

1. 实现公司 websocket 中心。
2. 发布运行/智能体/任务事件。
3. 更新 UI 页面以订阅并失效/更新相关数据。

## 阶段 5：提示药丸和配置 UX

1. 添加带有提示模板的适配器特定配置编辑器。
2. 添加药丸插入和变量验证。
3. 添加敏感变量警告和脱敏。

## 阶段 6：加固

1. 添加故障/重启恢复扫描。
2. 添加元数据/完整日志保留策略和修剪作业。
3. 添加唤醒触发器和实时更新的集成/端到端覆盖。

## 15. 验收标准

1. 使用 `claude-local` 或 `codex-local` 的智能体可以运行、退出并持久化运行结果。
2. 会话参数按任务范围持久化，并自动用于同一任务的恢复。
3. Token 使用按运行持久化并按智能体运行时状态累积。
4. 定时器、分配、按需和自动化唤醒全部通过一个协调器入队。
5. 暂停/终止中断正在运行的本地进程并阻止新唤醒。
6. 浏览器接收运行状态/日志和任务/智能体变更的实时 websocket 更新。
7. 失败的运行在 UI 中暴露丰富的 CLI 诊断，摘录立即可用，完整日志可通过 `RunLogStore` 检索。
8. 所有操作保持公司范围和可审计。

## 16. 待解决问题

1. 定时器默认值应该是 `null`（关闭直到启用）还是默认 `300` 秒？
2. 完整日志对象与 Postgres 元数据的默认保留策略应该是什么？
3. 智能体 API 凭据是否应默认允许在提示模板中使用，还是需要显式选择切换？
4. websocket 是否应该是唯一的实时通道，还是应该也暴露 SSE 给更简单的客户端？
