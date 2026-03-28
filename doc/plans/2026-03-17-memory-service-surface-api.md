# Paperclip 记忆服务计划

## 目标

定义一套 Paperclip 记忆服务及其表层 API，使其能够位于多个记忆后端之上，同时保留 Paperclip 控制平面的核心要求：

- 公司级隔离范围
- 可审计性
- 溯源至 Paperclip 工作对象
- 预算 / 成本可见性
- 插件优先的可扩展性

本计划基于 `doc/memory-landscape.md` 中总结的外部技术全景，以及以下文件中描述的当前 Paperclip 架构：

- `doc/SPEC-implementation.md`
- `doc/plugins/PLUGIN_SPEC.md`
- `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`
- `packages/plugins/sdk/src/types.ts`

## 一句话建议

Paperclip 不应将某一特定记忆引擎嵌入核心。它应添加一个公司级范围的记忆控制平面，并附带一套小型规范化适配器契约，然后由内置实现和插件负责提供商特定的行为。

## 产品决策

### 1. 记忆默认以公司为范围

每个记忆绑定恰好属于一家公司。

该绑定随后可以是：

- 公司默认绑定
- Agent 覆盖绑定
- 如有需要，后续添加项目级覆盖绑定

初始设计中不支持跨公司记忆共享。

### 2. 提供商通过键名选择

每个已配置的记忆提供商在公司内部拥有一个稳定的键名，例如：

- `default`
- `mem0-prod`
- `local-markdown`
- `research-kb`

Agent 和服务通过键名解析活跃提供商，而非通过硬编码的供应商逻辑。

### 3. 插件是主要的提供商接入路径

内置实现对零配置的本地路径很有价值，但大多数提供商应通过现有的 Paperclip 插件运行时接入。

这样可以保持核心精简，并与当前将可选知识型系统置于边缘的方向保持一致。

### 4. Paperclip 负责路由、溯源和计费

提供商不应决定 Paperclip 实体如何映射到治理机制。

Paperclip 核心应负责：

- 哪些主体被允许调用记忆操作
- 当前活跃的公司 / Agent / 项目范围
- 该操作属于哪个工单 / 运行 / 评论 / 文档
- 使用量如何被记录

### 5. 自动记忆在初期应保持范围收窄

自动捕获很有价值，但大范围的静默捕获是危险的。

初始自动钩子应为：

- Agent 运行结束后的捕获
- 绑定启用时的工单评论 / 文档捕获
- 运行前的记忆召回，用于 Agent 上下文预填充

其他所有情况应从显式操作开始。

## 核心概念

### 记忆提供商

内置或由插件提供的实现，负责存储和检索记忆。

示例：

- 本地 markdown + 向量索引
- mem0 适配器
- supermemory 适配器
- MemOS 适配器

### 记忆绑定

一条公司级范围的配置记录，指向某个提供商并携带该提供商的特定配置。

这是通过键名选择的对象。

### 记忆范围

传入提供商请求的规范化 Paperclip 范围对象。

最低包含：

- `companyId`
- 可选的 `agentId`
- 可选的 `projectId`
- 可选的 `issueId`
- 可选的 `runId`
- 可选的 `subjectId`，用于外部 / 用户身份

### 记忆来源引用

解释记忆来源的溯源句柄。

支持的来源类型应包括：

- `issue_comment`
- `issue_document`
- `issue`
- `run`
- `activity`
- `manual_note`
- `external_document`

### 记忆操作

通过 Paperclip 执行的规范化写入、查询、浏览或删除动作。

无论提供商是本地还是外部，Paperclip 都应记录每次操作的日志。

## 必需的适配器契约

必需的核心应足够精简，以兼容 `memsearch`、`mem0`、`Memori`、`MemOS` 或 `OpenViking`。

```ts
export interface MemoryAdapterCapabilities {
  profile?: boolean;
  browse?: boolean;
  correction?: boolean;
  asyncIngestion?: boolean;
  multimodal?: boolean;
  providerManagedExtraction?: boolean;
}

export interface MemoryScope {
  companyId: string;
  agentId?: string;
  projectId?: string;
  issueId?: string;
  runId?: string;
  subjectId?: string;
}

export interface MemorySourceRef {
  kind:
    | "issue_comment"
    | "issue_document"
    | "issue"
    | "run"
    | "activity"
    | "manual_note"
    | "external_document";
  companyId: string;
  issueId?: string;
  commentId?: string;
  documentKey?: string;
  runId?: string;
  activityId?: string;
  externalRef?: string;
}

export interface MemoryUsage {
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  costCents?: number;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface MemoryWriteRequest {
  bindingKey: string;
  scope: MemoryScope;
  source: MemorySourceRef;
  content: string;
  metadata?: Record<string, unknown>;
  mode?: "append" | "upsert" | "summarize";
}

export interface MemoryRecordHandle {
  providerKey: string;
  providerRecordId: string;
}

export interface MemoryQueryRequest {
  bindingKey: string;
  scope: MemoryScope;
  query: string;
  topK?: number;
  intent?: "agent_preamble" | "answer" | "browse";
  metadataFilter?: Record<string, unknown>;
}

export interface MemorySnippet {
  handle: MemoryRecordHandle;
  text: string;
  score?: number;
  summary?: string;
  source?: MemorySourceRef;
  metadata?: Record<string, unknown>;
}

export interface MemoryContextBundle {
  snippets: MemorySnippet[];
  profileSummary?: string;
  usage?: MemoryUsage[];
}

export interface MemoryAdapter {
  key: string;
  capabilities: MemoryAdapterCapabilities;
  write(req: MemoryWriteRequest): Promise<{
    records?: MemoryRecordHandle[];
    usage?: MemoryUsage[];
  }>;
  query(req: MemoryQueryRequest): Promise<MemoryContextBundle>;
  get(handle: MemoryRecordHandle, scope: MemoryScope): Promise<MemorySnippet | null>;
  forget(handles: MemoryRecordHandle[], scope: MemoryScope): Promise<{ usage?: MemoryUsage[] }>;
}
```

This contract intentionally does not force a provider to expose its internal graph, filesystem, or ontology.

## Optional Adapter Surfaces

These should be capability-gated, not required:

- `browse(scope, filters)` for file-system / graph / timeline inspection
- `correct(handle, patch)` for natural-language correction flows
- `profile(scope)` when the provider can synthesize stable preferences or summaries
- `sync(source)` for connectors or background ingestion
- `explain(queryResult)` for providers that can expose retrieval traces

## What Paperclip Should Persist

Paperclip should not mirror the full provider memory corpus into Postgres unless the provider is a Paperclip-managed local provider.

Paperclip core should persist:

- memory bindings and overrides
- provider keys and capability metadata
- normalized memory operation logs
- provider record handles returned by operations when available
- source references back to issue comments, documents, runs, and activity
- usage and cost data

For external providers, the memory payload itself can remain in the provider.

## Hook Model

### Automatic hooks

These should be low-risk and easy to reason about:

1. `pre-run hydrate`
   Before an agent run starts, Paperclip may call `query(... intent = "agent_preamble")` using the active binding.

2. `post-run capture`
   After a run finishes, Paperclip may write a summary or transcript-derived note tied to the run.

3. `issue comment / document capture`
   When enabled on the binding, Paperclip may capture selected issue comments or issue documents as memory sources.

### Explicit hooks

These should be tool- or UI-driven first:

- `memory.search`
- `memory.note`
- `memory.forget`
- `memory.correct`
- `memory.browse`

### Not automatic in the first version

- broad web crawling
- silent import of arbitrary repo files
- cross-company memory sharing
- automatic destructive deletion
- provider migration between bindings

## Agent UX Rules

Paperclip should give agents both automatic recall and explicit tools, with simple guidance:

- use `memory.search` when the task depends on prior decisions, people, projects, or long-running context that is not in the current issue thread
- use `memory.note` when a durable fact, preference, or decision should survive this run
- use `memory.correct` when the user explicitly says prior context is wrong
- rely on post-run auto-capture for ordinary session residue so agents do not have to write memory notes for every trivial exchange

This keeps memory available without forcing every agent prompt to become a memory-management protocol.

## Browse And Inspect Surface

Paperclip needs a first-class UI for memory, otherwise providers become black boxes.

The initial browse surface should support:

- active binding by company and agent
- recent memory operations
- recent write sources
- query results with source backlinks
- filters by agent, issue, run, source kind, and date
- provider usage / cost / latency summaries

When a provider supports richer browsing, the plugin can add deeper views through the existing plugin UI surfaces.

## Cost And Evaluation

Every adapter response should be able to return usage records.

Paperclip should roll up:

- memory inference tokens
- embedding tokens
- external provider cost
- latency
- query count
- write count

It should also record evaluation-oriented metrics where possible:

- recall hit rate
- empty query rate
- manual correction count
- per-binding success / failure counts

This is important because a memory system that "works" but silently burns budget is not acceptable in Paperclip.

## Suggested Data Model Additions

At the control-plane level, the likely new core tables are:

- `memory_bindings`
  - company-scoped key
  - provider id / plugin id
  - config blob
  - enabled status

- `memory_binding_targets`
  - target type (`company`, `agent`, later `project`)
  - target id
  - binding id

- `memory_operations`
  - company id
  - binding id
  - operation type (`write`, `query`, `forget`, `browse`, `correct`)
  - scope fields
  - source refs
  - usage / latency / cost
  - success / error

Provider-specific long-form state should stay in plugin state or the provider itself unless a built-in local provider needs its own schema.

## Recommended First Built-In

The best zero-config built-in is a local markdown-first provider with optional semantic indexing.

Why:

- it matches Paperclip's local-first posture
- it is inspectable
- it is easy to back up and debug
- it gives the system a baseline even without external API keys

The design should still treat that built-in as just another provider behind the same control-plane contract.

## Rollout Phases

### Phase 1: Control-plane contract

- add memory binding models and API types
- add plugin capability / registration surface for memory providers
- add operation logging and usage reporting

### Phase 2: One built-in + one plugin example

- ship a local markdown-first provider
- ship one hosted adapter example to validate the external-provider path

### Phase 3: UI inspection

- add company / agent memory settings
- add a memory operation explorer
- add source backlinks to issues and runs

### Phase 4: Automatic hooks

- pre-run hydrate
- post-run capture
- selected issue comment / document capture

### Phase 5: Rich capabilities

- correction flows
- provider-native browse / graph views
- project-level overrides if needed
- evaluation dashboards

## Open Questions

- Should project overrides exist in V1 of the memory service, or should we force company default + agent override first?
- Do we want Paperclip-managed extraction pipelines at all, or should built-ins be the only place where Paperclip owns extraction?
- Should memory usage extend the current `cost_events` model directly, or should memory operations keep a parallel usage log and roll up into `cost_events` secondarily?
- Do we want provider install / binding changes to require approvals for some companies?

## Bottom Line

The right abstraction is:

- Paperclip owns memory bindings, scopes, provenance, governance, and usage reporting.
- Providers own extraction, ranking, storage, and provider-native memory semantics.

That gives Paperclip a stable "memory service" without locking the product to one memory philosophy or one vendor.
