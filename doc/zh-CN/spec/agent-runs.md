# 智能体运行子系统规范

状态：草案
日期：2026-02-17
受众：产品+工程
范围：智能体执行运行时、适配器协议、唤醒编排和实时状态传递

## 1. 文档角色

该规范定义了 Paperclip 如何在保持运行时不可知的情况下实际运行智能体。

- `doc/SPEC-implementation.md` 仍为 V1 基线合约。
- 本文档添加了智能体执行的具体子系统详细信息，包括本地 CLI 适配器、运行时状态持久性、唤醒调度和浏览器实时更新。
- 如果此文档与代码中的当前运行时行为冲突，则此文档是即将实施的目标行为。

## 2. 捕获的意图（来自请求）

本规范明确保留了以下意图：

1. Paperclip 与适配器无关。关键是协议，而不是特定的运行时。
2. 我们仍然需要默认的内置程序来使系统立即可用。
3. 前两个内置函数是 `claude-local` 和 `codex-local`。
4. 这些适配器直接在主机上运行本地 CLI，未进行沙盒处理。
5. 智能体配置包括工作目录和初始/默认提示。
6. 心跳运行配置的适配器进程，Paperclip 管理生命周期，并在退出时 Paperclip 解析 JSON 输出并更新状态。
7. 必须保留会话 ID 和令牌使用情况，以便稍后可以恢复心跳。
8. 适配器应支持状态更新（短信+颜色）和可选的流日志。
9. UI应该支持提示模板“pills”用于变量插入。
10. CLI 错误必须在 UI 中完整（或尽可能）可见。
11. 状态更改必须通过服务器推送在任务和智能体视图之间实时更新。
12. 唤醒触发器应由心跳/唤醒服务集中，至少具有：
   - 定时器间隔
   - 任务分配唤醒
   - 显式 ping/请求

## 3. 目标和非目标

### 3.1 目标

1. 定义支持多个运行时的稳定适配器协议。
2. 为 Claude CLI 和 Codex CLI 提供生产可用的本地适配器。
3. 保留适配器运行时状态（会话 ID、令牌/成本使用情况、最后的错误）。
4. 将唤醒决策和排队集中到一项服务中。
5. 向浏览器提供实时运行/任务/智能体更新。
6. 支持特定于部署的完整日志存储，而不会使 Postgres 膨胀。
7. 保留公司范围和现有的治理不变性。

### 3.2 非目标（针对此子系统阶段）

1. 跨多个主机的分布式执行工作者。
2. 第三方适配器市场/插件SDK。
3. 为不排放成本的供应商提供完善的成本核算。
4. 超越基本保留的长期日志归档策略。

## 4. 基线和差距（截至 2026 年 2 月 17 日）

当前代码已经有：- `agents` 与 `adapterType` + `adapterConfig`。
- `heartbeat_runs` 具有基本状态跟踪功能。
- 进程内 `heartbeatService` 调用 `process` 和 `http`。
- 活动运行的取消端点。

该规范目前存在的差距：

1. 会话恢复没有持久的每个智能体运行时状态。
2. 无队列/唤醒抽象（调用是立即的）。
3. 无分配触发或定时器触发的集中唤醒。
4. 没有到浏览器的 websocket/SSE 推送路径。
5. 没有持久的运行事件时间线或外部完整日志存储合同。
6. Claude/Codex 会话和使用提取没有类型化的本地适配器合约。
7. 智能体设置中没有提示模板变量/药丸系统。
8. 没有用于完整运行日志存储（磁盘/对象存储/等）的部署感知适配器。

## 5. 架构概述

该子系统引入了六个协作组件：

1. `Adapter Registry`
   - 将 `adapter_type` 映射到实现。
   - 公开功能元数据和配置验证。

2. `Wakeup Coordinator`
   - 所有唤醒的单一入口点（`timer`、`assignment`、`on_demand`、`automation`）。
   - 应用重复数据删除/合并和队列规则。

3. `Run Executor`
   - 请求排队唤醒。
   - 创建 `heartbeat_runs`。
   - 生成/监视本地适配器的子进程。
   - 处理超时/取消/优雅杀死。

4. `Runtime State Store`
   - 保留每个智能体的可恢复适配器状态。
   - 保留运行使用摘要和轻量级运行事件时间表。

5. `Run Log Store`
   - 通过可插拔存储适配器保留完整的标准输出/标准错误流。
   - 返回稳定的 `logRef` 用于检索（本地路径、对象键或数据库引用）。

6. `Realtime Event Hub`
   - 通过 websocket 发布运行/智能体/任务更新。
   - 支持企业选择性订阅。

控制流程（快乐路径）：

1. 触发器到达（`timer`、`assignment`、`on_demand` 或 `automation`）。
2. 唤醒协调器排队/合并唤醒请求。
3. 执行者声明请求，创建运行行，标记智能体`running`。
4. 适配器执行，发出状态/日志/使用事件。
5. 完整日志流至`RunLogStore`；元数据/事件被保存到数据库并推送到 websocket 订阅者。
6. 进程退出，输出解析器更新运行结果+运行时状态。
7、智能体返回`idle`或`error`；用户界面实时更新。

## 6.智能体运行协议（版本`agent-run/v1`）

该协议与运行时无关并且由所有适配器实现。

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

### 6.1 所需行为1. `validateConfig` 在保存或调用之前运行。
2. `invoke` 对于给定的配置+运行时状态+提示必须是确定性的。
3. Adapter不能直接修改DB；它仅通过结果/事件返回数据。
4. 适配器必须发出足够的上下文才能调试错误。
5. 如果 `invoke` 抛出，执行程序将记录为 `failed` 运行并捕获错误文本。

### 6.2 可选行为

适配器可能会省略状态/日志挂钩。如果省略，运行时仍会发出系统生命周期状态（`queued`、`running`、`finished`）。

### 6.3 运行日志存储协议

完整运行日志由单独的可插入存储（而不是智能体适配器）管理。

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

1. 开发/本地默认：`local_file`（写入`data/run-logs/...`）。
2. 云/无服务器默认：`object_store`（兼容S3/R2/GCS）。
3. 可选后备：`postgres`，具有严格的尺寸上限。

### 6.4 适配器身份和兼容性

对于 V1 部署，适配器标识是明确的：

- `claude_local`
- `codex_local`
- `process`（通用现有行为）
- `http`（通用现有行为）

`claude_local` 和 `codex_local` 不是任意 `process` 的包装器；它们是具有已知解析器/恢复语义的类型适配器。

## 7. 内置适配器（第一阶段）

## 7.1 `claude-local`

直接运行本地`claude` CLI。

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

### 调用

- 基本命令：`claude --print <prompt> --output-format json`
- 恢复：当运行状态有会话ID时添加`--resume <sessionId>`
- 非沙盒模式：启用时添加 `--dangerously-skip-permissions`

### 输出解析

1. 解析stdout JSON 对象。
2. 提取`session_id`作为简历。
3. 提取使用字段：
   - `usage.input_tokens`
   - `usage.cache_read_input_tokens`（如果存在）
   - `usage.output_tokens`
4. 提取 `total_cost_usd`（如果存在）。
5. 非零退出时：仍然尝试解析；如果解析成功，则保留提取的状态并标记运行失败，除非适配器明确报告成功。

## 7.2 `codex-local`

直接运行本地`codex` CLI。

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

- 基本命令：`codex exec --json <prompt>`
- 简历表格：`codex exec --json resume <sessionId> <prompt>`
- 非沙盒模式：启用时添加 `--dangerously-bypass-approvals-and-sandbox`
- 可选搜索方式：添加`--search`

### 输出解析

Codex 发出 JSONL 事件。逐行解析并提取：

1. `thread.started.thread_id` -> 会话ID
2. `item.completed`，其中项目类型为 `agent_message` -> 输出文本
3. `turn.completed.usage`：
   - `input_tokens`
   - `cached_input_tokens`
   - `output_tokens`

Codex JSONL 目前可能不包含成本；存储令牌使用情况并将成本保留为空/未知（除非可用）。

## 7.3 常见本地适配器进程处理

两个本地适配器必须：1.使用`spawn(command, args, { shell: false, stdio: "pipe" })`。
2. 捕获流块中的 stdout/stderr 并转发到 `RunLogStore`。
3. 在内存中维护 DB 诊断字段的滚动 stdout/stderr 尾部摘录。
4. 向 websocket 订阅者发送实时日志事件（可选的限制/块）。
5. 支持优雅取消：`SIGTERM`，`graceSec`之后再`SIGKILL`。
6. 使用适配器 `timeoutSec` 强制超时。
7. 返回退出代码+解析结果+诊断stderr。

## 8. 心跳和唤醒协调器

## 8.1 唤醒源

支持的来源：

1. `timer`：每个智能体的定期心跳。
2. `assignment`：问题已分配/重新分配给智能体。
3. `on_demand`：显式唤醒请求路径（板/手动单击或 API ping）。
4. `automation`：非交互式唤醒路径（外部回调或内部系统自动化）。

## 8.2 中央API

所有来源均调用一项内部服务：

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

没有源直接调用适配器。

## 8.3 队列语义

1. 每个智能体的最大活动运行数仍为 `1`。
2. 如果智能体已经有 `queued`/`running` 运行：
   - 合并重复唤醒
   - 增加`coalescedCount`
   - 保留最新的原因/源元数据
3. 队列由数据库支持以确保重新启动安全。
4. 协调器使用`requested_at`的FIFO，优先级可选：
   - `on_demand` > `assignment` > `timer`/`automation`

## 8.4 智能体心跳策略字段

智能体级控制平面设置（不是特定于适配器的）：

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
- `intervalSec: null`（在明确设置之前没有计时器）或产品默认值 `300`（如果全局需要）
- `wakeOnAssignment: true`
- `wakeOnOnDemand: true`
- `wakeOnAutomation: true`

## 8.5 触发器积分规则

1. 计时器检查在服务器工作线程间隔上运行，并将到期智能体排队。
2. 当受让人发生变化并且目标智能体具有 `wakeOnAssignment=true` 时，问题分配突变会使唤醒入队。
3. 当 `wakeOnOnDemand=true` 时，按需端点将唤醒与 `source=on_demand` 和 `triggerDetail=manual|ping` 排队。
4. 当 `wakeOnAutomation=true` 时，回调/系统自动使用 `source=automation` 和 `triggerDetail=callback|system` 排队唤醒。
5. 暂停/终止的智能体不会收到新的唤醒。
6. 硬性预算停止的智能体不会收到新的唤醒。

## 9. 持久化模型

所有表格仍属于公司范围。

## 9.0 对 `agents` 的更改

1. 扩展 `adapter_type` 域以包含 `claude_local` 和 `codex_local`（以及现有的 `process`、`http`）。
2. 将 `adapter_config` 保留为适配器拥有的配置（CLI 标志、cwd、提示模板、env 覆盖）。
3、控制面调度策略添加`runtime_config` jsonb：
   - 心跳启用/间隔
   - 任务唤醒
   - 按需唤醒
   - 自动化唤醒
   - 冷却时间

这种分离使适配器配置与运行时无关，同时允许心跳服务应用一致的调度逻辑。## 9.1 新表：`agent_runtime_state`

每个智能体一行用于聚合运行时计数器和旧版兼容性。

- `agent_id` uuid PK FK `agents.id`
- `company_id` uuid fk 不为空
- `adapter_type` 文本不为空
- `session_id` 文字为空
- `state_json` jsonb 不为 null 默认 `{}`
- `last_run_id` uuid fk `heartbeat_runs.id` null
- `last_run_status` 文字为空
- `total_input_tokens` bigint 不为 null 默认 `0`
- `total_output_tokens` bigint 不为 null 默认 `0`
- `total_cached_input_tokens` bigint 不为 null 默认 `0`
- `total_cost_cents` bigint 不为 null 默认 `0`
- `last_error` 文字为空
- `updated_at` 时间戳不为空

不变：每个智能体只有一个运行时状态行。

## 9.1.1 新表：`agent_task_sessions`

每个 `(company_id, agent_id, adapter_type, task_key)` 一行用于可恢复会话状态。

- `id` uuid pk
- `company_id` uuid fk 不为空
- `agent_id` uuid fk 不为空
- `adapter_type` 文本不为空
- `task_key` 文本不为空
- `session_params_json` jsonb null（适配器定义的形状）
- `session_display_id` 文本为空（用于 UI/调试）
- `last_run_id` uuid fk `heartbeat_runs.id` null
- `last_error` 文字为空
- `created_at` 时间戳不为空
- `updated_at` 时间戳不为空

不变：唯一的`(company_id, agent_id, adapter_type, task_key)`。

## 9.2 新表：`agent_wakeup_requests`

队列+唤醒审核。

- `id` uuid pk
- `company_id` uuid fk 不为空
- `agent_id` uuid fk 不为空
- `source` 文本不为空 (`timer|assignment|on_demand|automation`)
- `trigger_detail` 文本为空 (`manual|ping|callback|system`)
- `reason` 文字为空
- `payload` jsonb 空
- `status` 文本不为空 (`queued|claimed|coalesced|skipped|completed|failed|cancelled`)
- `coalesced_count` int 不为 null 默认 `0`
- `requested_by_actor_type` 文本为空 (`user|agent|system`)
- `requested_by_actor_id` 文字为空
- `idempotency_key` 文字为空
- `run_id` uuid fk `heartbeat_runs.id` null
- `requested_at` 时间戳不为空
- `claimed_at` 时间戳空
- `finished_at` 时间戳空
- `error` 文字为空

## 9.3 新表：`heartbeat_run_events`

仅附加每次运行的轻量级事件时间线（没有完整的原始日志块）。

- `id` bigserial pk
- `company_id` uuid fk 不为空
- `run_id` uuid fk `heartbeat_runs.id` 不为空
- `agent_id` uuid fk `agents.id` 不为空
- `seq` int 不为空
- `event_type` 文本不为空 (`lifecycle|status|usage|error|structured`)
- `stream` 文本为空 (`system|stdout|stderr`)（仅汇总事件，而不是完整流块）
- `level` 文本为空 (`info|warn|error`)
- `color` 文字为空
- `message` 文字为空
- `payload` jsonb 空
- `created_at` 时间戳不为空

## 9.4 `heartbeat_runs` 的更改

添加结果和诊断所需的字段：- `wakeup_request_id` uuid fk `agent_wakeup_requests.id` null
- `exit_code` int null
- `signal` 文字为空
- `usage_json` jsonb 空
- `result_json` jsonb 空
- `session_id_before` 文字为空
- `session_id_after` 文字为空
- `log_store` 文本为空 (`local_file|object_store|postgres`)
- `log_ref` 文本为空（不透明的提供程序引用；路径/键/uri/行 ID）
- `log_bytes` bigint null
- `log_sha256` 文字为空
- `log_compressed` 布尔值不为 null 默认 false
- `stderr_excerpt` 文字为空
- `stdout_excerpt` 文字为空
- `error_code` 文字为空

这使得每次运行的诊断都可查询，而无需在 Postgres 中存储完整日志。

## 9.5 日志存储适配器配置

运行时日志存储是部署配置的（默认情况下不是每个智能体）。

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

1. `log_ref` 在 API 边界上必须是不透明且提供商中立的。
2. UI/API 不得采用本地文件系统语义。
3. 提供商特定的秘密/凭证保留在服务器配置中，而不是智能体配置中。

## 10.提示模板和药丸系统

## 10.1 模板格式

- 小胡子风格占位符：`{{path.to.value}}`
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
- `paperclip.skill`（共享Paperclip技能文本块）
- `credentials.apiBaseUrl`
- `credentials.apiKey`（可选，敏感）

## 10.3 提示字段

1. `promptTemplate`
   - 每次唤醒时使用（首次运行和恢复运行）。
   - 可包含跑步源/原因药丸。

## 10.4 用户界面要求

1. 智能体设置/编辑表单包括带有药丸插入的提示编辑器。
2. 变量显示为可点击的药丸，以便快速插入。
3. 保存时间验证表明未知/缺失变量。
4. 敏感药片（`credentials.*`）显示明确的警告标志。

## 10.5 凭证的安全说明

1. 为了最初的简单性，允许提示中的凭据，但不鼓励。
2. 首选传输是在运行时注入的环境变量 (`PAPERCLIP_*`)。
3. 提示预览和日志必须编辑敏感值。

## 11. 实时状态传递

## 11.1 运输

主要传输：每个公司的 websocket 通道。

- 端点：`GET /api/companies/:companyId/events/ws`
- 身份验证：董事会会议或智能体 API 密钥（公司绑定）

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

## 11.3 所需的事件类型

1. `agent.status.changed`
2. `heartbeat.run.queued`
3. `heartbeat.run.started`
4. `heartbeat.run.status`（短彩+留言更新）
5. `heartbeat.run.log`（可选的实时块流；由`RunLogStore`处理完全持久性）
6. `heartbeat.run.finished`
7. `issue.updated`
8. `issue.comment.created`
9. `activity.appended`

## 11.4 用户界面行为1. 智能体详细信息视图更新实时运行时间线。
2. 任务板反映座席活动的分配/状态/评论更改，无需刷新。
3. 组织/智能体列表实时反映状态变化。
4. 如果 websocket 断开连接，客户端将回退到短轮询，直到重新连接。

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

## 12.2 日志记录要求

1. 将完整的 stdout/stderr 流保留到配置的 `RunLogStore`。
2. 仅在 Postgres 中保留轻量级运行元数据/事件（`heartbeat_runs`、`heartbeat_run_events`）。
3. 在 Postgres 中保留有界的 `stdout_excerpt` 和 `stderr_excerpt` 以进行快速诊断。
4. 当摘录受到限制时，明确标记截断。
5. 编辑日志、摘录和 Websocket 有效负载中的机密。

## 12.3 日志保留和生命周期

1. `RunLogStore` 保留期可通过部署进行配置（例如 7/30/90 天）。
2. Postgres 运行元数据的寿命可能比完整日志对象的寿命长。
3. 删除/修剪作业必须安全地处理孤立的元数据/日志对象引用。
4. 如果完整日志对象消失，API 仍返回状态为 `log_unavailable` 的元数据和摘录。

## 12.4 重启恢复

服务器启动时：

1. 查找陈旧的 `queued`/`running` 运行。
2、用`error_code=control_plane_restart`标记为`failed`。
3. 将受影响的非暂停/非终止智能体设置为 `error`（或根据策略设置为 `idle`）。
4. 将恢复事件发送到 websocket 和活动日志。

## 13. API 表面变化

## 13.1 新的/更新的端点

1. `POST /agents/:agentId/wakeup`
   - 将唤醒与源/原因排队
2. `POST /agents/:agentId/heartbeat/invoke`
   - 向后兼容唤醒别名 API
3. `GET /agents/:agentId/runtime-state`
   - 仅板调试视图
4. `GET /agents/:agentId/task-sessions`
   - 任务范围适配器会话的仅董事会列表
5. `POST /agents/:agentId/runtime-state/reset-session`
   - 清除智能体的所有任务会话，或者在提供 `taskKey` 时清除一个任务会话
6. `GET /heartbeat-runs/:runId/events?afterSeq=:n`
   - 获取持久的轻量级时间线
7. `GET /heartbeat-runs/:runId/log`
   - 通过 `RunLogStore` 读取完整日志流（或对象存储的重定向/预签名 URL）
8. `GET /api/companies/:companyId/events/ws`
   - 网络套接字流

## 13.2 突变记录

所有唤醒/运行状态突变必须创建 `activity_log` 条目：

- `wakeup.requested`
- `wakeup.coalesced`
- `heartbeat.started`
- `heartbeat.finished`
- `heartbeat.failed`
- `heartbeat.cancelled`
- `runtime_state.updated`

## 14.心跳服务实施方案

## 第 1 阶段：合约和架构

1. 添加新的数据库表/列（`agent_runtime_state`、`agent_wakeup_requests`、`heartbeat_run_events`、`heartbeat_runs.log_*` 字段）。
2. 增加`RunLogStore`接口及配置接线。
3. 添加共享类型/常量/验证器。
4. 在迁移过程中保持现有路由的功能。

## 第 2 阶段：唤醒协调器1. 实现数据库支持的唤醒队列。
2. 将调用/唤醒路由转换为使用 `source=on_demand` 和适当的 `triggerDetail` 排队。
3. 添加工作循环以声明并执行排队唤醒。

## 第 3 阶段：本地适配器

1. 实现`claude-local`适配器。
2. 实现`codex-local`适配器。
3. 解析并保留会话 ID 和令牌使用情况。
4. 线路取消/超时/宽限行为。

## 第四阶段：实时推送

1. 实施公司websocket hub。
2. 发布运行/智能体/问题事件。
3. 更新UI页面订阅和失效/更新相关数据。

## 第 5 阶段：提示药丸和配置 UX

1. 添加带有提示模板的适配器特定配置编辑器。
2. 添加药丸插入和变量验证。
3. 添加敏感变量警告和密文。

## 第 6 阶段：强化

1. 添加故障/重启恢复扫描。
2. 添加元数据/完整日志保留策略和修剪作业。
3. 添加唤醒触发器和实时更新的集成/e2e 覆盖范围。

## 15. 验收标准

1. `claude-local` 或 `codex-local` 的智能体可以运行、退出并保存运行结果。
2. 会话参数按任务范围保留，并在相同任务恢复时自动重用。
3. 令牌使用情况会在每次运行时保持不变，并根据智能体运行时状态进行累积。
4. 定时器、分配、按需和自动唤醒均通过一个协调器进行排队。
5. 暂停/终止中断正在运行的本地进程并防止新的唤醒。
6. 浏览器接收运行状态/日志和任务/智能体更改的实时 Websocket 更新。
7. 失败的运行会在 UI 中公开丰富的 CLI 诊断信息，并可立即提供摘录，并可通过 `RunLogStore` 检索完整日志。
8. 所有行动均在公司范围内且可审计。

## 16. 开放性问题

1. 定时器默认应该是`null`（关闭直到启用）还是`300` 秒？
2. 完整日志对象与 Postgres 元数据的默认保留策略应该是什么？
3. 默认情况下，提示模板中是否应允许智能体 API 凭据，还是需要显式选择加入切换？
4. websocket 应该是唯一的实时通道，还是应该为更简单的客户端公开 SSE？