# Paperclip Memory Service Plan

## Goal

Define a Paperclip memory service and surface API that can sit above multiple memory backends, while preserving Paperclip's control-plane requirements:

- company scoping
- auditability
- provenance back to Paperclip work objects
- budget and cost visibility
- plugin-first extensibility

This plan is based on the external landscape summarized in `doc/memory-landscape.md`, the AWS AgentCore comparison captured in [PAP-1274](/PAP/issues/PAP-1274), and the current Paperclip architecture in:

- `doc/SPEC-implementation.md`
- `doc/plugins/PLUGIN_SPEC.md`
- `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`
- `packages/plugins/sdk/src/types.ts`

## Recommendation In One Sentence

Paperclip should add a company-scoped memory control plane with company default plus agent override resolution, shared hook delivery, and full operation attribution, while leaving extraction and storage semantics to built-ins and plugins.

## Product Decisions

### 1. Memory resolution is company default plus agent override

Every memory binding belongs to exactly one company.

Resolution order in V1:

- company default binding
- optional per-agent override

There is no per-project override in V1.

Project context can still appear in scope and provenance so providers can use it for retrieval and partitioning, but projects do not participate in binding selection.

No cross-company memory sharing in the initial design.

### 2. Providers are selected by stable binding key

Each configured memory provider gets a stable key inside a company, for example:

- `default`
- `mem0-prod`
- `local-markdown`
- `research-kb`

Agents, tools, and background hooks resolve the active provider by key, not by hard-coded vendor logic.

### 3. Plugins are the primary provider path

Built-ins are useful for a zero-config local path, but most providers should arrive through the existing Paperclip plugin runtime.

That keeps the core small and matches the broader Paperclip direction that specialized knowledge systems live at the edges.

### 4. Paperclip owns routing, provenance, and policy

Providers should not decide how Paperclip entities map to governance.

Paperclip core should own:

- binding resolution
- who is allowed to call a memory operation
- which company, agent, issue, project, run, and subject scope is active
- what source object the operation belongs to
- how usage and costs are attributed
- how operators inspect what happened

### 5. Paperclip exposes shared hooks, providers own extraction

Paperclip should emit a common set of memory hooks that built-ins, third-party adapters, and plugins can all use.

Those hooks should pass structured Paperclip source objects plus normalized metadata. The provider then decides how to extract from those objects.

Paperclip should not force one extraction pipeline or one canonical "memory text" transform before the provider sees the input.

### 6. Automatic memory should start narrow, but the hook surface should be general

Automatic capture is useful, but broad silent capture is dangerous.

Initial built-in automatic hooks should be:

- pre-run hydrate for agent context recall
- post-run capture from agent runs
- optional issue comment capture
- optional issue document capture

The hook registry itself should be general enough that other providers can subscribe to the same events without core changes.

### 7. No approval gate for binding changes in the open-source product

For the open-source version, changing memory bindings should not require approvals.

Paperclip should still log those changes in activity and preserve full auditability. Approval-gated memory governance can remain an enterprise or future policy layer.

## Proposed Concepts

### Memory provider

A built-in or plugin-supplied implementation that stores and retrieves memory.

Examples:

- local markdown plus semantic index
- mem0 adapter
- supermemory adapter
- MemOS adapter

### Memory binding

A company-scoped configuration record that points to a provider and carries provider-specific config.

This is the object selected by key.

### Memory binding target

A mapping from a Paperclip target to a binding.

V1 targets:

- `company`
- `agent`

### Memory scope

The normalized Paperclip scope passed into a provider request.

At minimum:

- `companyId`
- optional `agentId`
- optional `projectId`
- optional `issueId`
- optional `runId`
- optional `subjectId` for external or user identity
- optional `sessionKey` for providers that organize memory around sessions
- optional `namespace` for providers that need an explicit partition hint

### Memory source reference

The provenance handle that explains where a memory came from.

Supported source kinds should include:

- `issue_comment`
- `issue_document`
- `issue`
- `run`
- `activity`
- `manual_note`
- `external_document`

### Memory hook

A normalized trigger emitted by Paperclip when something memory-relevant happens.

Initial hook kinds:

- `pre_run_hydrate`
- `post_run_capture`
- `issue_comment_capture`
- `issue_document_capture`
- `manual_capture`

### Memory operation

A normalized capture, record-write, query, browse, get, correction, or delete action performed through Paperclip.

Paperclip should log every memory operation whether the provider is local, plugin-backed, or external.

## Required Adapter Contract

The required core should be small enough to fit `memsearch`, `mem0`, `Memori`, `MemOS`, or `OpenViking`, but strong enough to satisfy Paperclip's attribution and inspectability requirements.

```ts
export interface MemoryAdapterCapabilities {
  profile?: boolean;
  correction?: boolean;
  multimodal?: boolean;
  providerManagedExtraction?: boolean;
  asyncExtraction?: boolean;
  providerNativeBrowse?: boolean;
}

export interface MemoryScope {
  companyId: string;
  agentId?: string;
  projectId?: string;
  issueId?: string;
  runId?: string;
  subjectId?: string;
  sessionKey?: string;
  namespace?: string;
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

export interface MemoryHookContext {
  hookKind:
    | "pre_run_hydrate"
    | "post_run_capture"
    | "issue_comment_capture"
    | "issue_document_capture"
    | "manual_capture";
  hookId: string;
  triggeredAt: string;
  actorAgentId?: string;
  heartbeatRunId?: string;
}

export interface MemorySourcePayload {
  text?: string;
  mimeType?: string;
  metadata?: Record<string, unknown>;
  object?: Record<string, unknown>;
}

export interface MemoryUsage {
  provider: string;
  biller?: string;
  model?: string;
  billingType?: "metered_api" | "subscription_included" | "subscription_overage" | "unknown";
  attributionMode?: "billed_directly" | "included_in_run" | "external_invoice" | "untracked";
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  costCents?: number;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

export interface MemoryRecordHandle {
  providerKey: string;
  providerRecordId: string;
}

export interface MemoryCaptureRequest {
  bindingKey: string;
  scope: MemoryScope;
  source: MemorySourceRef;
  payload: MemorySourcePayload;
  hook?: MemoryHookContext;
  mode?: "capture_residue" | "capture_record";
  metadata?: Record<string, unknown>;
}

export interface MemoryRecordWriteRequest {
  bindingKey: string;
  scope: MemoryScope;
  source?: MemorySourceRef;
  records: Array<{
    text: string;
    summary?: string;
    metadata?: Record<string, unknown>;
  }>;
}

export interface MemoryQueryRequest {
  bindingKey: string;
  scope: MemoryScope;
  query: string;
  topK?: number;
  intent?: "agent_preamble" | "answer" | "browse";
  metadataFilter?: Record<string, unknown>;
}

export interface MemoryListRequest {
  bindingKey: string;
  scope: MemoryScope;
  cursor?: string;
  limit?: number;
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

export interface MemoryListPage {
  items: MemorySnippet[];
  nextCursor?: string;
  usage?: MemoryUsage[];
}

export interface MemoryExtractionJob {
  providerJobId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  hookKind?: MemoryHookContext["hookKind"];
  source?: MemorySourceRef;
  error?: string;
  submittedAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface MemoryAdapter {
  key: string;
  capabilities: MemoryAdapterCapabilities;
  capture(req: MemoryCaptureRequest): Promise<{
    records?: MemoryRecordHandle[];
    jobs?: MemoryExtractionJob[];
    usage?: MemoryUsage[];
  }>;
  upsertRecords(req: MemoryRecordWriteRequest): Promise<{
    records?: MemoryRecordHandle[];
    usage?: MemoryUsage[];
  }>;
  query(req: MemoryQueryRequest): Promise<MemoryContextBundle>;
  list(req: MemoryListRequest): Promise<MemoryListPage>;
  get(handle: MemoryRecordHandle, scope: MemoryScope): Promise<MemorySnippet | null>;
  forget(handles: MemoryRecordHandle[], scope: MemoryScope): Promise<{ usage?: MemoryUsage[] }>;
}
```

This contract intentionally does not force a provider to expose its internal graph, file tree, or ontology. It does require enough structure for Paperclip to browse, attribute, and audit what happened.

## Optional Adapter Surfaces

These should be capability-gated, not required:

- `correct(handle, patch)` for natural-language correction flows
- `profile(scope)` when the provider can synthesize stable preferences or summaries
- `listExtractionJobs(scope, cursor)` when async extraction needs richer operator visibility
- `retryExtractionJob(jobId)` when a provider supports re-drive
- `explain(queryResult)` for providers that can expose retrieval traces
- provider-native browse or graph surfaces exposed through plugin UI

## Lessons From AWS AgentCore Memory API

AWS AgentCore Memory is a useful check on whether this plan is too abstract or missing important operational surfaces.

The broad direction still looks right:

- AWS splits memory into a control plane (`CreateMemory`, `UpdateMemory`, `ListMemories`) and a data plane (`CreateEvent`, `RetrieveMemoryRecords`, `GetMemoryRecord`, `ListMemoryRecords`)
- AWS separates raw interaction capture from curated long-term memory records
- AWS supports both provider-managed extraction and self-managed pipelines
- AWS treats browse and list operations as first-class APIs, not ad hoc debugging helpers
- AWS exposes extraction jobs instead of hiding asynchronous maintenance completely

That lines up with the Paperclip plan at a high level: provider configuration, scoped writes, scoped retrieval, provider-managed extraction as a capability, and a browse and inspect surface.

The concrete changes Paperclip should take from AWS are:

### 1. Keep config APIs separate from runtime traffic

The rollout should preserve a clean separation between:

- control-plane APIs for binding CRUD, defaults, overrides, and capability metadata
- runtime APIs and tools for capture, record writes, query, list, get, forget, and extraction status

This keeps governance changes distinct from high-volume memory traffic.

### 2. Distinguish capture from curated record writes

AWS does not flatten everything into one write primitive. It distinguishes captured events from durable memory records.

Paperclip should do the same:

- `capture(...)` for raw run, comment, document, or activity residue
- `upsertRecords(...)` for curated durable facts and notes

That is a better fit for provider-managed extraction and for manual curation flows.

### 3. Make list and browse first-class

AWS exposes list and retrieve surfaces directly. Paperclip should not make browse optional at the portable layer.

The minimum portable surface should include:

- `query`
- `list`
- `get`

Provider-native graph or file browsing can remain optional beyond that.

### 4. Add pagination and cursors for operator inspection

AWS consistently uses pagination on browse-heavy APIs.

Paperclip should add cursor-based pagination to:

- record listing
- extraction job listing
- memory operation explorer APIs

Prompt hydration can continue to use `topK`, but operator surfaces need cursors.

### 5. Add explicit session and namespace hints

AWS uses `actorId`, `sessionId`, `namespace`, and `memoryStrategyId` heavily.

Paperclip should keep its own control-plane-centric model, but the adapter contract needs obvious places to map those concepts:

- `sessionKey`
- `namespace`

The provider adapter can map them to AWS or other vendor-specific identifiers without leaking those identifiers into core.

### 6. Treat asynchronous extraction as a real operational surface

AWS exposes extraction jobs explicitly. Paperclip should too.

Operators should be able to see:

- pending extraction work
- failed extraction work
- which hook or source caused the work
- whether a retry is available

### 7. Keep Paperclip provenance primary

Paperclip should continue to center:

- `companyId`
- `agentId`
- `projectId`
- `issueId`
- `runId`
- issue comments, documents, and activity as sources

The lesson from AWS is to support clean mapping into provider-specific models, not to let provider identifiers take over the core product model.

## What Paperclip Should Persist

Paperclip should not mirror the full provider memory corpus into Postgres unless the provider is a Paperclip-managed local provider.

Paperclip core should persist:

- memory bindings
- company default and agent override resolution targets
- provider keys and capability metadata
- normalized memory operation logs
- source references back to issue comments, documents, runs, and activity
- provider record handles returned by operations when available
- hook delivery records and extraction job state
- usage and cost attribution

For external providers, the actual memory payload can remain in the provider.

## Hook Model

### Shared hook surface

Paperclip should expose one shared hook system for memory.

That same system must be available to:

- built-in memory providers
- plugin-based memory providers
- third-party adapter integrations that want to use memory hooks

### What a hook delivers

Each hook delivery should include:

- resolved binding key
- normalized `MemoryScope`
- `MemorySourceRef`
- structured source payload
- hook metadata such as hook kind, trigger time, and related run id

The payload should include structured objects where possible so the provider can decide how to extract and chunk.

### Initial automatic hooks

These should be low-risk and easy to reason about:

1. `pre_run_hydrate`
   Before an agent run starts, Paperclip may call `query(... intent = "agent_preamble")` using the active binding.

2. `post_run_capture`
   After a run finishes, Paperclip may call `capture(...)` with structured run output, excerpts, and provenance.

3. `issue_comment_capture`
   When enabled on the binding, Paperclip may call `capture(...)` for selected issue comments.

4. `issue_document_capture`
   When enabled on the binding, Paperclip may call `capture(...)` for selected issue documents.

### Explicit tools and APIs

These should be tool-driven or UI-driven first:

- `memory.search`
- `memory.note`
- `memory.forget`
- `memory.correct`
- memory record list and get
- extraction-job inspection

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
- recent write and capture sources
- record list and record detail with source backlinks
- query results with source backlinks
- extraction job status
- filters by agent, issue, project, run, source kind, and date
- provider usage, cost, and latency summaries

When a provider supports richer browsing, the plugin can add deeper views through the existing plugin UI surfaces.

## Cost And Evaluation

Paperclip should treat memory accounting as two related but distinct concerns:

### 1. `memory_operations` is the authoritative audit trail

Every memory action should create a normalized operation record that captures:

- binding
- scope
- source provenance
- operation type
- success or failure
- latency
- usage details reported by the provider
- attribution mode
- related run, issue, and agent when available

This is where operators answer "what memory work happened and why?"

### 2. `cost_events` remains the canonical spend ledger for billable metered usage

The current `cost_events` model is already the canonical cost ledger for token and model spend, and `agent_runtime_state` plus `heartbeat_runs.usageJson` already roll up and summarize run usage.

The recommendation is:

- if a memory operation runs inside a normal Paperclip agent heartbeat and the model usage is already counted on that run, do not create a duplicate `cost_event`
- instead, store the memory operation with `attributionMode = "included_in_run"` and link it to the related `heartbeatRunId`
- if a memory provider makes a direct metered model call outside the agent run accounting path, the provider must report usage and Paperclip should create a `cost_event`
- that direct `cost_event` should still link back to the memory operation, agent, company, and issue or run context when possible

### 3. `finance_events` should carry flat subscription or invoice-style costs

If a memory service incurs:

- monthly subscription cost
- storage invoices
- provider platform charges not tied to one request

those should be represented as `finance_events`, not as synthetic per-query memory operations.

That keeps usage telemetry separate from accounting entries like invoices and flat fees.

### 4. Evaluation metrics still matter

Paperclip should record evaluation-oriented metrics where possible:

- recall hit rate
- empty query rate
- manual correction count
- extraction failure count
- per-binding success and failure counts

This is important because a memory system that "works" but silently burns budget or silently fails extraction is not acceptable in Paperclip.

## Suggested Data Model Additions

At the control-plane level, the likely new core tables are:

- `memory_bindings`
  - company-scoped key
  - provider id or plugin id
  - config blob
  - enabled status

- `memory_binding_targets`
  - target type (`company`, `agent`)
  - target id
  - binding id

- `memory_operations`
  - company id
  - binding id
  - operation type (`capture`, `record_upsert`, `query`, `list`, `get`, `forget`, `correct`)
  - scope fields
  - source refs
  - usage, latency, and attribution mode
  - related heartbeat run id
  - related cost event id
  - success or error

- `memory_extraction_jobs`
  - company id
  - binding id
  - operation id
  - provider job id
  - hook kind
  - status
  - source refs
  - error
  - submitted, started, and finished timestamps

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
- add company default plus agent override resolution
- add plugin capability and registration surface for memory providers

### Phase 2: Hook delivery and operation audit

- add shared memory hook emission in core
- add operation logging, extraction job state, and usage attribution
- add direct-provider cost and finance-event linkage rules

### Phase 3: One built-in plus one plugin example

- ship a local markdown-first provider
- ship one hosted adapter example to validate the external-provider path

### Phase 4: UI inspection

- add company and agent memory settings
- add a memory operation explorer
- add record list and detail surfaces
- add source backlinks to issues and runs

### Phase 5: Rich capabilities

- correction flows
- provider-native browse or graph views
- evaluation dashboards
- retention and quota controls

## Remaining Open Questions

- Which built-in local provider should ship first: pure markdown, markdown plus embeddings, or a lightweight local vector store?
- How much source payload should Paperclip snapshot inside `memory_operations` for debugging without duplicating large transcripts?
- Should correction flows mutate provider state directly, create superseding records, or both depending on provider capability?
- What default retention and size limits should the local built-in enforce?

## Bottom Line

The right abstraction is:

- Paperclip owns bindings, resolution, hooks, provenance, policy, and attribution.
- Providers own extraction, ranking, storage, and provider-native memory semantics.

That gives Paperclip a stable memory service without locking the product to one memory philosophy or one vendor, and it integrates the AWS lessons without importing AWS's model into core.
