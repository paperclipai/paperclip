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

### 6.1 Required Behavior

1. `validateConfig` runs before saving or invoking.
2. `invoke` must be deterministic for a given config + runtime state + prompt.
3. Adapter must not mutate DB directly; it returns data via result/events only.
4. Adapter must emit enough context for errors to be debuggable.
5. If `invoke` throws, executor records run as `failed` with captured error text.

### 6.2 Optional Behavior

Adapters may omit status/log hooks. If omitted, runtime still emits system lifecycle statuses (`queued`, `running`, `finished`).

### 6.3 Run log storage protocol

Full run logs are managed by a separate pluggable store (not by the agent adapter).

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

V1 deployment defaults:

1. Dev/local default: `local_file` (write to `data/run-logs/...`).
2. Cloud/serverless default: `object_store` (S3/R2/GCS compatible).
3. Optional fallback: `postgres` with strict size caps.

### 6.4 Adapter identity and compatibility

For V1 rollout, adapter identity is explicit:

- `claude_local`
- `codex_local`
- `process` (generic existing behavior)
- `http` (generic existing behavior)

`claude_local` and `codex_local` are not wrappers around arbitrary `process`; they are typed adapters with known parser/resume semantics.

## 7. Built-in Adapters (Phase 1)

## 7.1 `claude-local`

Runs local `claude` CLI directly.

### Config

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

### Invocation

- Base command: `claude --print <prompt> --output-format json`
- Resume: add `--resume <sessionId>` when runtime state has session ID
- Unsandboxed mode: add `--dangerously-skip-permissions` when enabled

### Output parsing

1. Parse stdout JSON object.
2. Extract `session_id` for resume.
3. Extract usage fields:
   - `usage.input_tokens`
   - `usage.cache_read_input_tokens` (if present)
   - `usage.output_tokens`
4. Extract `total_cost_usd` when present.
5. On non-zero exit: still attempt parse; if parse succeeds keep extracted state and mark run failed unless adapter explicitly reports success.

## 7.2 `codex-local`

Runs local `codex` CLI directly.

### Config

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

### Invocation

- Base command: `codex exec --json <prompt>`
- Resume form: `codex exec --json resume <sessionId> <prompt>`
- Unsandboxed mode: add `--dangerously-bypass-approvals-and-sandbox` when enabled
- Optional search mode: add `--search`

### Output parsing

Codex emits JSONL events. Parse line-by-line and extract:

1. `thread.started.thread_id` -> session ID
2. `item.completed` where item type is `agent_message` -> output text
3. `turn.completed.usage`:
   - `input_tokens`
   - `cached_input_tokens`
   - `output_tokens`

Codex JSONL currently may not include cost; store token usage and leave cost null/unknown unless available.

## 7.3 Common local adapter process handling

Both local adapters must:

1. Use `spawn(command, args, { shell: false, stdio: "pipe" })`.
2. Capture stdout/stderr in stream chunks and forward to `RunLogStore`.
3. Maintain rolling stdout/stderr tail excerpts in memory for DB diagnostic fields.
4. Emit live log events to websocket subscribers (optional to throttle/chunk).
5. Support graceful cancel: `SIGTERM`, then `SIGKILL` after `graceSec`.
6. Enforce timeout using adapter `timeoutSec`.
7. Return exit code + parsed result + diagnostic stderr.

## 8. Heartbeat and Wakeup Coordinator

## 8.1 Wakeup sources

Supported sources:

1. `timer`: periodic heartbeat per agent.
2. `assignment`: issue assigned/reassigned to agent.
3. `on_demand`: explicit wake request path (board/manual click or API ping).
4. `automation`: non-interactive wake path (external callback or internal system automation).

## 8.2 Central API

All sources call one internal service:

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

No source invokes adapters directly.

## 8.3 Queue semantics

1. Max active run per agent remains `1`.
2. If agent already has `queued`/`running` run:
   - coalesce duplicate wakeups
   - increment `coalescedCount`
   - preserve latest reason/source metadata
3. Queue is DB-backed for restart safety.
4. Coordinator uses FIFO by `requested_at`, with optional priority:
   - `on_demand` > `assignment` > `timer`/`automation`

## 8.4 Agent heartbeat policy fields

Agent-level control-plane settings (not adapter-specific):

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

Defaults:

- `enabled: true`
- `intervalSec: null` (no timer until explicitly set) or product default `300` if desired globally
- `wakeOnAssignment: true`
- `wakeOnOnDemand: true`
- `wakeOnAutomation: true`

## 8.5 Trigger integration rules

1. Timer checks run on server worker interval and enqueue due agents.
2. Issue assignment mutation enqueues wakeup when assignee changes and target agent has `wakeOnAssignment=true`.
3. On-demand endpoint enqueues wakeup with `source=on_demand` and `triggerDetail=manual|ping` when `wakeOnOnDemand=true`.
4. Callback/system automations enqueue wakeup with `source=automation` and `triggerDetail=callback|system` when `wakeOnAutomation=true`.
5. Paused/terminated agents do not receive new wakeups.
6. Hard budget-stopped agents do not receive new wakeups.

## 9. Persistence Model

All tables remain company-scoped.

## 9.0 Changes to `agents`

1. Extend `adapter_type` domain to include `claude_local` and `codex_local` (alongside existing `process`, `http`).
2. Keep `adapter_config` as adapter-owned config (CLI flags, cwd, prompt templates, env overrides).
3. Add `runtime_config` jsonb for control-plane scheduling policy:
   - heartbeat enable/interval
   - wake-on-assignment
   - wake-on-on-demand
   - wake-on-automation
   - cooldown

This separation keeps adapter config runtime-agnostic while allowing the heartbeat service to apply consistent scheduling logic.

## 9.1 New table: `agent_runtime_state`

One row per agent for aggregate runtime counters and legacy compatibility.

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

Invariant: exactly one runtime state row per agent.

## 9.1.1 New table: `agent_task_sessions`

One row per `(company_id, agent_id, adapter_type, task_key)` for resumable session state.

- `id` uuid pk
- `company_id` uuid fk not null
- `agent_id` uuid fk not null
- `adapter_type` text not null
- `task_key` text not null
- `session_params_json` jsonb null (adapter-defined shape)
- `session_display_id` text null (for UI/debug)
- `last_run_id` uuid fk `heartbeat_runs.id` null
- `last_error` text null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Invariant: unique `(company_id, agent_id, adapter_type, task_key)`.

## 9.2 New table: `agent_wakeup_requests`

Queue + audit for wakeups.

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

## 9.3 New table: `heartbeat_run_events`

Append-only per-run lightweight event timeline (no full raw log chunks).

- `id` bigserial pk
- `company_id` uuid fk not null
- `run_id` uuid fk `heartbeat_runs.id` not null
- `agent_id` uuid fk `agents.id` not null
- `seq` int not null
- `event_type` text not null (`lifecycle|status|usage|error|structured`)
- `stream` text null (`system|stdout|stderr`) (summarized events only, not full stream chunks)
- `level` text null (`info|warn|error`)
- `color` text null
- `message` text null
- `payload` jsonb null
- `created_at` timestamptz not null

## 9.4 Changes to `heartbeat_runs`

Add fields required for result and diagnostics:

- `wakeup_request_id` uuid fk `agent_wakeup_requests.id` null
- `exit_code` int null
- `signal` text null
- `usage_json` jsonb null
- `result_json` jsonb null
- `session_id_before` text null
- `session_id_after` text null
- `log_store` text null (`local_file|object_store|postgres`)
- `log_ref` text null (opaque provider reference; path/key/uri/row id)
- `log_bytes` bigint null
- `log_sha256` text null
- `log_compressed` boolean not null default false
- `stderr_excerpt` text null
- `stdout_excerpt` text null
- `error_code` text null

This keeps per-run diagnostics queryable without storing full logs in Postgres.

## 9.5 Log storage adapter configuration

Runtime log storage is deployment-configured (not per-agent by default).

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

Rules:

1. `log_ref` must be opaque and provider-neutral at API boundaries.
2. UI/API must not assume local filesystem semantics.
3. Provider-specific secrets/credentials stay in server config, never in agent config.

## 10. Prompt Template and Pill System

## 10.1 Template format

- Mustache-style placeholders: `{{path.to.value}}`
- No arbitrary code execution.
- Unknown variable on save = validation error.

## 10.2 Initial variable catalog

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
- `paperclip.skill` (shared Paperclip skill text block)
- `credentials.apiBaseUrl`
- `credentials.apiKey` (optional, sensitive)

## 10.3 Prompt fields

1. `promptTemplate`
   - Used on every wakeup (first run and resumed runs).
   - Can include run source/reason pills.

## 10.4 UI requirements

1. Agent setup/edit form includes prompt editors with pill insertion.
2. Variables are shown as clickable pills for fast insertion.
3. Save-time validation indicates unknown/missing variables.
4. Sensitive pills (`credentials.*`) show explicit warning badge.

## 10.5 Security notes for credentials

1. Credentials in prompt are allowed for initial simplicity but discouraged.
2. Preferred transport is env vars (`PAPERCLIP_*`) injected at runtime.
3. Prompt preview and logs must redact sensitive values.

## 11. Realtime Status Delivery

## 11.1 Transport

Primary transport: websocket channel per company.

- Endpoint: `GET /api/companies/:companyId/events/ws`
- Auth: board session or agent API key (company-bound)

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

## 11.3 Required event types

1. `agent.status.changed`
2. `heartbeat.run.queued`
3. `heartbeat.run.started`
4. `heartbeat.run.status` (short color+message updates)
5. `heartbeat.run.log` (optional live chunk stream; full persistence handled by `RunLogStore`)
6. `heartbeat.run.finished`
7. `issue.updated`
8. `issue.comment.created`
9. `activity.appended`

## 11.4 UI behavior

1. Agent detail view updates run timeline live.
2. Task board reflects assignment/status/comment changes from agent activity without refresh.
3. Org/agent list reflects status changes live.
4. If websocket disconnects, client falls back to short polling until reconnect.

## 12. Error Handling and Diagnostics

## 12.1 Error classes

- `adapter_not_installed`
- `invalid_working_directory`
- `spawn_failed`
- `timeout`
- `cancelled`
- `nonzero_exit`
- `output_parse_error`
- `resume_session_invalid`
- `budget_blocked`

## 12.2 Logging requirements

1. Persist full stdout/stderr stream to configured `RunLogStore`.
2. Persist only lightweight run metadata/events in Postgres (`heartbeat_runs`, `heartbeat_run_events`).
3. Persist bounded `stdout_excerpt` and `stderr_excerpt` in Postgres for quick diagnostics.
4. Mark truncation explicitly when excerpts are capped.
5. Redact secrets from logs, excerpts, and websocket payloads.

## 12.3 Log retention and lifecycle

1. `RunLogStore` retention is configurable by deployment (for example 7/30/90 days).
2. Postgres run metadata can outlive full log objects.
3. Deletion/pruning jobs must handle orphaned metadata/log-object references safely.
4. If full log object is gone, APIs still return metadata and excerpts with `log_unavailable` status.

## 12.4 Restart recovery

On server startup:

1. Find stale `queued`/`running` runs.
2. Mark as `failed` with `error_code=control_plane_restart`.
3. Set affected non-paused/non-terminated agents to `error` (or `idle` based on policy).
4. Emit recovery events to websocket and activity log.

## 13. API Surface Changes

## 13.1 New/updated endpoints

1. `POST /agents/:agentId/wakeup`
   - enqueue wakeup with source/reason
2. `POST /agents/:agentId/heartbeat/invoke`
   - backward-compatible alias to wakeup API
3. `GET /agents/:agentId/runtime-state`
   - board-only debug view
4. `GET /agents/:agentId/task-sessions`
   - board-only list of task-scoped adapter sessions
5. `POST /agents/:agentId/runtime-state/reset-session`
   - clears all task sessions for the agent, or one when `taskKey` is provided
6. `GET /heartbeat-runs/:runId/events?afterSeq=:n`
   - fetch persisted lightweight timeline
7. `GET /heartbeat-runs/:runId/log`
   - reads full log stream via `RunLogStore` (or redirects/presigned URL for object store)
8. `GET /api/companies/:companyId/events/ws`
   - websocket stream

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
