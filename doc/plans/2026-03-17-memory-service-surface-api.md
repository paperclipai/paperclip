# Paperclip Memory Service Plan

## Goal

Define a Paperclip memory service and surface API that can sit above multiple memory backends, while preserving Paperclip's control-plane requirements:

- company scoping
- auditability
- provenance back to Paperclip work objects
- budget / cost visibility
- plugin-first extensibility

This plan is based on the external landscape summarized in `doc/memory-landscape.md` and on the current Paperclip architecture in:

- `doc/SPEC-implementation.md`
- `doc/plugins/PLUGIN_SPEC.md`
- `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`
- `packages/plugins/sdk/src/types.ts`

## Recommendation In One Sentence

Paperclip should not embed one opinionated memory engine into core. It should add a company-scoped memory control plane with a small normalized adapter contract, then let built-ins and plugins implement the provider-specific behavior.

## Product Decisions

### 1. Memory is company-scoped by default

Every memory binding belongs to exactly one company.

That binding can then be:

- the company default
- an agent override
- a project override later if we need it

No cross-company memory sharing in the initial design.

### 2. Providers are selected by key

Each configured memory provider gets a stable key inside a company, for example:

- `default`
- `mem0-prod`
- `local-markdown`
- `research-kb`

Agents and services resolve the active provider by key, not by hard-coded vendor logic.

### 3. Plugins are the primary provider path

Built-ins are useful for a zero-config local path, but most providers should arrive through the existing Paperclip plugin runtime.

That keeps the core small and matches the current direction that optional knowledge-like systems live at the edges.

### 4. Paperclip owns routing, provenance, and accounting

Providers should not decide how Paperclip entities map to governance.

Paperclip core should own:

- who is allowed to call a memory operation
- which company / agent / project scope is active
- what issue / run / comment / document the operation belongs to
- how usage gets recorded

### 5. Automatic memory should be narrow at first

Automatic capture is useful, but broad silent capture is dangerous.

Initial automatic hooks should be:

- post-run capture from agent runs
- issue comment / document capture when the binding enables it
- pre-run recall for agent context hydration

Everything else should start explicit.

## Proposed Concepts

### Memory provider

A built-in or plugin-supplied implementation that stores and retrieves memory.

Examples:

- local markdown + vector index
- mem0 adapter
- supermemory adapter
- MemOS adapter

### Memory binding

A company-scoped configuration record that points to a provider and carries provider-specific config.

This is the object selected by key.

### Memory scope

The normalized Paperclip scope passed into a provider request.

At minimum:

- `companyId`
- optional `agentId`
- optional `projectId`
- optional `issueId`
- optional `runId`
- optional `subjectId` for external/user identity

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

### Memory operation

A normalized write, query, browse, or delete action performed through Paperclip.

Paperclip should log every operation, whether the provider is local or external.

## Required Adapter Contract

The required core should be small enough to fit `memsearch`, `mem0`, `Memori`, `MemOS`, or `OpenViking`.

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
