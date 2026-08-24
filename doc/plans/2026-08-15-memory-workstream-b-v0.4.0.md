# Workstream B — Memory & Knowledge (v0.4.0)

**Part of**: Project Polaris (VOY-1184)
**Date**: 2026-08-15
**Author**: Staff Engineer
**Status**: Draft for review

## 1. Memory Store Evaluation

### Evaluated Options

| Option | Latency | Operational Overhead | Inspectability | Integration Effort | License |
|--------|---------|---------------------|----------------|-------------------|---------|
| **A. pgvector (Postgres extension)** | Low (in-DB query) | ~0 — already have Postgres | Medium (SQL queries) | Low | MIT |
| **B. SQLite FTS5 (Hermes-native)** | Very low | ~0 — Hermes already uses it | High (file on disk) | Very low | Public domain |
| **C. Markdown files + optional vector index** | Low | Low | Very high | Low | N/A |
| **D. Plugin adapter to external provider (mem0 etc.)** | Varies | Low (plugin-managed) | Depends on provider | Medium | N/A |
| **E. Dedicated vector DB (Qdrant, Milvus, Weaviate)** | Low | High — new infra | Good UI tools | High | Varies |

### Recommendation

**Two-tier strategy — Built-in pgvector + Plugin adapter contract.**

Paperclip already runs Postgres. Adding the `pgvector` extension gives us:
- No new infrastructure dependencies
- Full ACID transactions on memory records alongside business data
- SQL-level inspectability for operators
- `ivfflat` or `hnsw` index for efficient vector similarity search
- Freedom to join memory records with issues, comments, runs, agents in a single query

For the plugin path, the existing `PluginEventBus` already provides the hook substrate. Plugin memory providers register via the same `MemoryAdapter` contract defined in `doc/plans/2026-03-17-memory-service-surface-api.md`.

**Decision**: Use pgvector as the core built-in. Plugin adapter contract for external providers.

### Why not pure markdown or SQLite FTS5?

- Hermes already uses FTS5 for session search, but Paperclip needs cross-session, cross-agent, company-scoped memory — not just single-session recall.
- Markdown-only loses structured query (by agent, company, project, date range) without shelling out to grep/qmd.
- pgvector gives us both structured query AND semantic search in one place, matching the "searchable" requirement.

---

## 2. Data Model

### New Server-Side Tables

#### `memory_bindings`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `company_id` | `uuid` FK → companies | |
| `key` | `text` | Stable binding key, e.g. `"default"`, `"mem0-prod"` |
| `provider_type` | `text` | `"builtin_pgvector"` or plugin id |
| `config_json` | `jsonb` | Provider-specific config (model, topK, etc.) |
| `capabilities_json` | `jsonb` | Declared capability flags |
| `enabled` | `boolean` | Soft disable without deleting config |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |

UNIQUE(company_id, key)

#### `memory_binding_targets`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `company_id` | `uuid` FK → companies | |
| `target_type` | `text` | `"company"` or `"agent"` |
| `target_id` | `uuid` | FK to companies or agents |
| `binding_id` | `uuid` FK → memory_bindings | |
| `priority` | `int` | For override resolution (higher = wins) |
| `created_at` | `timestamptz` | |

UNIQUE(company_id, target_type, target_id)

Resolution order: find agent target → fall back to company default target.

#### `memory_records`

This is the core memory data store. Embeddings live here alongside structured metadata.

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `company_id` | `uuid` FK → companies | |
| `binding_id` | `uuid` FK → memory_bindings | |
| `record_type` | `text` | `"auto_capture"`, `"curated_note"`, `"profile"`, `"decision"` |
| `text` | `text` | The actual memory content |
| `summary` | `text` | Optional short summary for UI display |
| `embedding` | `vector(1536)` | pgvector column, nullable (filled async or absent for non-semantic records) |
| `scope_company_id` | `uuid` | |
| `scope_agent_id` | `uuid` | nullable |
| `scope_project_id` | `uuid` | nullable |
| `scope_issue_id` | `uuid` | nullable |
| `scope_run_id` | `uuid` | nullable |
| `scope_subject_id` | `text` | nullable — for external/user identity |
| `scope_session_key` | `text` | nullable — for session-partitioned memory |
| `scope_namespace` | `text` | nullable — provider partition hint |
| `source_kind` | `text` | `"issue_comment"`, `"issue_document"`, `"issue"`, `"run"`, `"activity"`, `"manual_note"`, `"external_document"` |
| `source_issue_id` | `uuid` | nullable |
| `source_comment_id` | `uuid` | nullable |
| `source_document_key` | `text` | nullable |
| `source_run_id` | `uuid` | nullable |
| `source_activity_id` | `uuid` | nullable |
| `source_external_ref` | `text` | nullable |
| `metadata_json` | `jsonb` | Arbitrary provider/plugin metadata |
| `importance` | `float` | nullable — provider-assigned importance score |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | |
| `expires_at` | `timestamptz` | nullable — TTL for auto-expiring memory |

Indexes:
- `memory_records_company_scope_idx` on (company_id, scope_agent_id, record_type)
- `memory_records_source_idx` on (company_id, source_kind, source_issue_id)
- `memory_records_embedding_idx` via pgvector `hnsw` index on embedding
- `memory_records_text_search_idx` via GIN on to_tsvector('english', text)

#### `memory_operations` (audit log)

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `company_id` | `uuid` FK → companies | |
| `binding_id` | `uuid` FK → memory_bindings | |
| `operation_type` | `text` | `"capture"`, `"record_upsert"`, `"query"`, `"list"`, `"get"`, `"forget"`, `"correct"` |
| `scope_json` | `jsonb` | Snapshot of MemoryScope at operation time |
| `source_ref_json` | `jsonb` | Snapshot of source provenance |
| `actor_agent_id` | `uuid` | nullable |
| `heartbeat_run_id` | `uuid` | nullable |
| `success` | `boolean` | |
| `error_message` | `text` | nullable |
| `latency_ms` | `int` | |
| `usage_json` | `jsonb` | Token/cost details from provider |
| `record_count` | `int` | Number of records affected |
| `created_at` | `timestamptz` | |

#### `memory_extraction_jobs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` PK | |
| `company_id` | `uuid` FK → companies | |
| `binding_id` | `uuid` FK → memory_bindings | |
| `operation_id` | `uuid` FK → memory_operations | nullable |
| `provider_job_id` | `text` | Provider-side job identifier |
| `hook_kind` | `text` | `"post_run_capture"`, `"issue_comment_capture"`, `"issue_document_capture"` |
| `status` | `text` | `"queued"`, `"running"`, `"succeeded"`, `"failed"`, `"cancelled"` |
| `error_message` | `text` | nullable |
| `submitted_at` | `timestamptz` | |
| `started_at` | `timestamptz` | nullable |
| `finished_at` | `timestamptz` | nullable |

### Types in `@paperclipai/shared`

These types should be added to `packages/shared/src/types/`:

```typescript
// Memory binding and configuration
export interface MemoryBindingConfig {
  providerType: "builtin_pgvector" | string; // plugin id for plugin providers
  configJson: Record<string, unknown>;
  capabilitiesJson: MemoryCapabilities;
}

export interface MemoryCapabilities {
  profile?: boolean;
  correction?: boolean;
  multimodal?: boolean;
  providerManagedExtraction?: boolean;
  asyncExtraction?: boolean;
  providerNativeBrowse?: boolean;
}

export interface MemoryRecord {
  id: string;
  companyId: string;
  bindingId: string;
  recordType: "auto_capture" | "curated_note" | "profile" | "decision";
  text: string;
  summary?: string;
  scope: MemoryScope;
  source: MemorySourceRef;
  metadataJson?: Record<string, unknown>;
  importance?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
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
  kind: "issue_comment" | "issue_document" | "issue" | "run" | "activity" | "manual_note" | "external_document";
  companyId: string;
  issueId?: string;
  commentId?: string;
  documentKey?: string;
  runId?: string;
  activityId?: string;
  externalRef?: string;
}

export interface MemoryQueryRequest {
  bindingKey: string;
  scope: MemoryScope;
  query: string;
  topK?: number;
  intent?: "agent_preamble" | "answer" | "browse";
  metadataFilter?: Record<string, unknown>;
}

export interface MemoryContextBundle {
  snippets: MemorySnippet[];
  profileSummary?: string;
  usage?: MemoryUsage[];
}

export interface MemorySnippet {
  handle: MemoryRecordHandle;
  text: string;
  score?: number;
  summary?: string;
  source?: MemorySourceRef;
  metadata?: Record<string, unknown>;
}

export interface MemoryRecordHandle {
  providerKey: string;
  providerRecordId: string;
}

export interface MemoryUsage {
  provider: string;
  biller?: string;
  model?: string;
  billingType?: "metered_api" | "subscription_included" | "subscription_overage" | "unknown";
  attributionMode?: "billed_directly" | "included_in_run" | "external_invoice" | "untracked";
  inputTokens?: number;
  outputTokens?: number;
  embeddingTokens?: number;
  costCents?: number;
  latencyMs?: number;
}
```

---

## 3. Context Injection Architecture

### The Problem

Memory query at heartbeat start adds latency. If the agent blocks on memory retrieval before it can begin work, the perceived startup cost of every heartbeat goes up by the embedding query time (typically 50-200ms for pgvector, potentially several seconds for external providers).

### Design: Async Warm-Up, Pre-Fetched Not Inline

```
Heartbeat Start
  │
  ├──▶ [async warm-up path]
  │      │
  │      ├──▶ Resolve binding for agent (company default → agent override)
  │      │
  │      ├──▶ Build MemoryScope from run context
  │      │      - companyId, agentId, projectId, issueId
  │      │
  │      ├──▶ Call query(intent="agent_preamble", topK=10)
  │      │      - runs in parallel with other startup I/O
  │      │      - result: MemoryContextBundle
  │      │
  │      ├──▶ Format snippets as markdown preamble
  │      │
  │      └──▶ Inject into agent prompt preamble as:
  │             === Context from Past Work ===
  │             - From issue VOY-123: "... summary of prior decision ..."
  │             - Regarding project Alpha: "... historical context ..."
  │             === End Context ===
  │
  └──▶ [normal heartbeat start]
         │
         ├──▶ If warm-up succeeded → inject preamble
         ├──▶ If warm-up failed/timed out → continue without memory
         └──▶ Agent begins execution
```

### Key Properties

1. **Async, not deferred**: The memory fetch runs in a Promise that gets `await`ed before the agent adapter is invoked, but it runs concurrently with other pre-run I/O (skill sync, secret resolution, workspace setup).

2. **Graceful degradation**: If memory fetch times out or fails, the heartbeat proceeds without context. The failure is logged in `memory_operations` but does not block work.

3. **Pre-fetched, not inline**: The agent does NOT call `memory.search()` during its run to get preamble context. The context is already in the prompt when it starts. This avoids N+1 memory queries during execution and keeps latency predictable.

4. **Agent-scoped first**: Warm-up queries scope to `companyId + agentId`. Cross-agent company-level knowledge comes in a later phase.

5. **Intelligent deduplication**: The preamble injects a compressed representation — snippets with scores and source references, not raw text. Long-term, `summary` fields and `importance` scores help select the most relevant context.

### Integration Points

The warm-up logic belongs in the heartbeat service (`server/src/services/heartbeat.ts`), in the same async phase where skill resolution and secret binding happen. Specifically:

```
resolveHeartbeatRun() {
  // existing: resolve agent, issue, workspace, secrets
  // NEW: resolve memory binding + warm-up query
  const memoryContext = await warmUpAgentMemory({
    companyId,
    agentId,
    projectId,
    issueId,
    runId,
  }).catch(err => {
    logger.warn({err}, "Memory warm-up failed, continuing without context");
    return null;
  });

  // inject into prompt preamble
  if (memoryContext) {
    agentInstructions += buildMemoryPreamble(memoryContext);
  }
}
```

---

## 4. Memory Browser UI Plan

### Settings Surface

- Company Settings → Memory tab
  - List active bindings
  - Add/edit/delete bindings
  - Set company default
- Agent Settings → Memory tab
  - Show inherited binding (from company)
  - Option to override per-agent
  - Memory browser for this agent's records

### Memory Explorer

- Navigation: Companies → Company → Memory tab
  - Or direct: `/companies/{id}/memory`
- Views:
  - **Recent**: Paginated list of recent memory operations
  - **Records**: Browse by agent, project, date range, source kind
  - **Search**: Full-text + semantic query (topK results with scores)
- Record detail:
  - Full text
  - Source backlinks (click → open the source issue/comment/run)
  - Scope breakdown (agent, project, issue)
  - Metadata payload
  - Timeline (created, updated, expires)
- Extraction jobs:
  - Status dashboard for async extraction
  - Retry button for failed jobs

### Plugin UI Extension

Memory providers can register plugin UI surfaces:
- Provider-native graph browser
- Custom record visualizations
- Training/feedback interfaces

---

## 5. Implementation Phases

### Phase 1: Foundation — Schema + Types + Resolution (v0.4.0-alpha)

Child issue: VOY-1188
Effort: ~2-3 days

- [ ] Add pgvector migration to existing Postgres (CREATE EXTENSION vector;)
- [ ] Create memory_bindings, memory_binding_targets tables
- [ ] Add types to @paperclipai/shared (MemoryScope, MemorySourceRef, etc.)
- [ ] Implement binding resolution service (company default → agent override)
- [ ] Add REST API endpoints:
  - POST/GET /api/companies/{id}/memory-bindings
  - POST/GET /api/companies/{id}/memory-bindings/{id}/targets
  - GET /api/agents/{id}/memory-config (resolved binding)

Depends-on: VOY-1186 (Deep Planning) for the v0.4.0-alpha timeline

### Phase 2: Core Engine — pgvector Adapter + CRUD (v0.4.0-beta)

Child issue: VOY-1189
Effort: ~3-4 days

- [ ] Create memory_records, memory_operations, memory_extraction_jobs tables
- [ ] Implement builtin_pgvector MemoryAdapter:
  - capture() — upsert with embedding generation
  - upsertRecords() — direct curated record write
  - query() — semantic + full-text hybrid search
  - list() — cursor-based pagination
  - get() — by record handle
  - forget() — delete by handle
- [ ] Embedding generation: use the same model provider as the agent's configured LLM, or a configurable embedding model
- [ ] Record memory_operations for every action
- [ ] Add memory state to the existing plugin state system for plugin providers

### Phase 3: Context Injection + Hooks (v0.4.0-beta)

Child issue: VOY-1190
Effort: ~2-3 days

- [ ] Implement async warm-up in heartbeat service (pre-run hydrate)
- [ ] Post-run capture hook (auto-capture run summary/decisions)
- [ ] Issue comment/document capture hooks (opt-in)
- [ ] Build memory preamble injection
- [ ] Add graceful degradation (timeout, failure handling, logging)
- [ ] Agent-level memory tools: memory.search, memory.note, memory.forget

### Phase 4: Memory Browser UI (v0.4.0-beta)

Child issue: VOY-1191
Effort: ~3-4 days

- [ ] Company Settings → Memory tab (binding management)
- [ ] Agent Settings → Memory tab (override + browser)
- [ ] Memory Explorer view (records, search, operations log)
- [ ] Source backlinks (click through to issue/comment/run)
- [ ] Extraction job status dashboard
- [ ] Basic cost/latency display in memory operations log

### Phase 5: Company Knowledge Base + Polish (v0.4.0-rc)

Child issue: VOY-1192
Effort: ~3-5 days

- [ ] Company-level knowledge base concept (curated, reviewed records)
- [ ] Promote agent-scoped records to company knowledge
- [ ] Versioning for curated knowledge entries
- [ ] Approval flow for knowledge base changes
- [ ] Performance tuning (embedding index rebuild, query optimization)
- [ ] Provider capability negotiation (capability flags)

---

## 6. Key Constraints and Guardrails

1. **Memory attaches to plans**: Deep Planning (v0.4.0-alpha) ships first. Memory work begins in earnest during v0.4.0-beta cycle. Phase 1 (schema + types) can start in parallel since it doesn't depend on plans.

2. **Agent-scoped first**: Phase 1-4 focus on agent-level memory. Company KB comes in Phase 5.

3. **No scope creep**: This workstream does NOT touch:
   - MAXIMIZER MODE (separate workstream)
   - Work Queues (separate workstream)
   - Self-Organization (separate workstream)
   - CEO Chat (separate workstream, VOY-1193)

4. **Async warm-up, never inline**: The context injection path must be pre-fetched before the agent starts, not queried during execution. This is a hard constraint.

5. **Plugin compatibility**: The adapter contract must be implementable by plugins. The built-in pgvector provider validates the contract, but all capabilities should be available to plugin providers too.

6. **Cost transparency**: Every memory operation is logged with latency, token usage, and cost attribution. No silent memory work.

---

## 7. CTO Decisions

The following decisions are approved as of 2026-08-15:

### 7.1 Embedding Model

**Decision**: Use a **dedicated embedding model** (`text-embedding-3-small`, 1536-dim) as the default. Rationale:
- Embedding models are optimized for vector similarity and significantly cheaper than chat models.
- Using a chat model for embeddings would be wasteful — a 30k-token embedding call costs the same as a short chat completion but produces lower-quality vectors.
- Decoupling means changing the agent model does not change the embedding space, preserving existing vectors.
- Configurable per-binding: the binding config stores `{ embeddingModel, dimensions }`, defaulting to `text-embedding-3-small` / 1536.

### 7.2 Default Retention

**Decision**: 30d TTL for auto-captured, indefinite for curated. Confirmed:
- Auto-captured run residues are high-volume and low-value at long horizons.
- Curated notes, profiles, and decisions are explicitly created to persist.
- Add a company-level default TTL setting for auto-captured memory in the binding config.

### 7.3 Local Embedding Fallback

**Decision**: For Phase 1-4, if no embedding API key is available, fall back to **keyword/full-text search only** (GIN tsvector index on `memory_records.text`). Rationale:
- `text-embedding-3-small` requires an OpenAI-compatible API endpoint.
- For fully local deployments, the GIN full-text index provides reasonable search without external dependencies.
- `sentence-transformers` can be evaluated as a Phase 5 enhancement — it requires bundling a Python/ONNX runtime which is not trivial for a Node.js deployment. Schema dimension note: if we later support 384-dim models, we may need a second vector column or a migration strategy; this is deferred.

### 7.4 UI Priority

**Decision**: **Agent Memory settings first** (binding management), then Memory Explorer. Rationale:
- Settings (binding management, override) must exist before operators can configure memory to produce data worth exploring.
- The Memory Explorer depends on memory data existing, so configuring bindings is the prerequisite.
- Phase 4 scope: Agent Settings → Memory tab ships first, Memory Explorer ships in the same phase but after settings are usable.

---

## 8. Implementation Assignment Plan (CTO Directive)

| Phase | Impl Issue | Code Review Issue | Implementation By | Code Review By |
|-------|-----------|-------------------|-------------------|----------------|
| 1 — Foundation | VOY-1189 | *(see note)* | Founding Engineer | Staff Engineer |
| 2 — Core Engine | VOY-1190 | *(see note)* | Founding Engineer | Staff Engineer |
| 3 — Context Injection + Hooks | VOY-1203 | VOY-1206 | Founding Engineer | Staff Engineer (blocked on VOY-1203) |
| 4 — Memory Browser UI | VOY-1204 | VOY-1207 | Founding Engineer | Staff Engineer (blocked on VOY-1204) |
| 5 — Company Knowledge Base | VOY-1205 | VOY-1208 | Founding Engineer | Staff Engineer (blocked on VOY-1205) |

**Note on Phase 1 & 2**: VOY-1189 and VOY-1190 were originally created by the Staff Engineer during evaluation. They need reassignment from Staff Engineer to Founding Engineer for implementation. Code review child issues for these phases will be created once the reassignment is confirmed.

Release + QA tracking at the workstream level when phases are ready for deployment.

---

### References

- `doc/memory-landscape.md` — External memory system survey
- `doc/plans/2026-03-17-memory-service-surface-api.md` — Memory adapter contract design
- `doc/plugins/PLUGIN_SPEC.md` — Plugin event bus and state system
- `packages/plugins/sdk/src/types.ts` — Plugin SDK types
- `ROADMAP.md` — Project roadmap and milestone context