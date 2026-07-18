# Paperclip Operational Audit 2026 — Sprint 4
## 10A EXTERNAL ADAPTERS AND HTTP AGENTS

**Evidence date:** 2026-07-15  
**Scope:** Built-in vs external adapters, adapter registry, plugin-based adapter loading, configuration, execution contract, heartbeat, identity, authentication, secrets, session persistence, timeout/retry, auditability, and whether an intake worker should be an adapter.

---

## 1. Built-in Adapters vs External Adapter Plugins

### 1.1 Built-in adapters
These are hardcoded in the server source and registered at startup:

| Type | Source |
|------|--------|
| `claude_local` | In-tree (`server/src/adapters/claude-local/`) |
| `codex_local` | In-tree (`server/src/adapters/codex-local/`) |
| `cursor` | In-tree |
| `gemini_local` | In-tree |
| `openclaw_gateway` | In-tree |
| `opencode_local` | In-tree |
| `pi_local` | In-tree |
| `hermes_local` | Externalized in this fork (see AGENTS.md §11) |
| `process` | Built-in local process adapter |
| `http` | Built-in HTTP adapter |

**File:** `server/src/adapters/builtin-adapter-types.ts`
```typescript
export const BUILTIN_ADAPTER_TYPES = new Set([
  "claude_local", "codex_local", "cursor", "gemini_local",
  "openclaw_gateway", "opencode_local", "pi_local",
  "hermes_local", "process", "http",
]);
```

### 1.2 External adapter plugins
Loaded dynamically from npm packages or local paths:
- Stored metadata at `~/.paperclip/adapter-plugins.json`
- Loaded at server startup via `buildExternalAdapters()`
- Registered via `registerServerAdapter()`
- Can override built-in types via `resolveExternalAdapterRegistration()` with `overriddenBuiltin` flag

**Key symbols:**
- `server/src/adapters/plugin-loader.ts::buildExternalAdapters()`
- `server/src/services/adapter-plugin-store.ts` — JSON file store
- `server/src/routes/adapters.ts` — install/reload/unregister API

**Confidence: HIGH**

---

## 2. Registration and Discovery

### 2.1 External adapter discovery
1. On server startup, `buildExternalAdapters()` reads `~/.paperclip/adapter-plugins.json`.
2. For each record, it calls `loadFromRecord()`, which:
   - Resolves the package directory (npm `node_modules` or `localPath`)
   - Imports the entrypoint module
   - Validates that `createServerAdapter()` is exported
   - Caches the UI parser source if available

### 2.2 Hot-install at runtime
- `POST /api/adapters/install` — npm install or local path; loads and registers immediately.
- `POST /api/adapters/:type/reload` — busts ESM cache, re-imports, re-registers.
- `POST /api/adapters/:type/reinstall` — npm update + reload.

### 2.3 Registry
The adapter registry (`server/src/adapters/registry.ts` — not inspected directly but referenced) maintains:
- `listServerAdapters()` — all registered adapters
- `findServerAdapter(type)` — lookup by type
- `findActiveServerAdapter(type)` — active adapter (external override or builtin)
- `registerServerAdapter(module)` — add to runtime
- `unregisterServerAdapter(type)` — remove from runtime

**Key symbols:**
- `server/src/adapters/plugin-loader.ts::loadExternalAdapterPackage()`
- `server/src/adapters/plugin-loader.ts::reloadExternalAdapter()`
- `server/src/routes/adapters.ts::POST /api/adapters/install`

**Confidence: HIGH**

---

## 3. Configuration Storage

### 3.1 Adapter config schema
Each adapter module can export `getConfigSchema(): Promise<AdapterConfigSchema>`.
- Served via `GET /api/adapters/:type/config-schema`
- Cached for 30 seconds (`CONFIG_SCHEMA_TTL_MS`)
- Returns fully hydrated schema with static and dynamic options

### 3.2 Agent-level adapter config
When creating an agent, the operator selects an adapter type and provides config values. These are:
- Stored in `agents` table (likely in a JSONB column, though the exact column was not inspected)
- Passed to the adapter at execution time via `AdapterExecutionContext`

**Confidence: MEDIUM** — config schema endpoint fully implemented; agent config persistence inferred from adapter execution contracts.

---

## 4. Execution Contract

Adapters implement `ServerAdapterModule` (from `@paperclipai/adapter-utils`):

```typescript
interface ServerAdapterModule {
  type: string;
  label: string;
  models: AdapterModel[];
  detectModel?(config: unknown): string | null;
  getConfigSchema?(): Promise<AdapterConfigSchema>;
  execute(context: AdapterExecutionContext): Promise<AdapterExecutionResult>;
  // Optional: skills, sessions, environment checks
  listSkills?(...): Promise<...>;
  syncSkills?(...): Promise<...>;
  supportsInstructionsBundle?: boolean;
  supportsSkills?: boolean;
  supportsLocalAgentJwt?: boolean;
  requiresMaterializedRuntimeSkills?: boolean;
  sessionManagement?: AdapterSessionManagement;
}
```

### 4.1 Execution context
The host constructs an `AdapterExecutionContext` containing:
- Agent config
- Session state (if session management is supported)
- Instructions bundle
- Environment lease (if applicable)
- Issue context

### 4.2 Execution result
The adapter returns `AdapterExecutionResult` with:
- Run artifacts (transcript, tool calls, etc.)
- Usage summary (tokens, cost)
- Status

**Key symbols:**
- `server/src/adapters/types.ts` — re-exports from `@paperclipai/adapter-utils`

**Confidence: MEDIUM** — types inspected; detailed execution flow not traced.

---

## 5. Heartbeat Contract

The heartbeat service (`server/src/services/heartbeat.ts` — not fully inspected) coordinates agent wakeups:
- `heartbeat.wakeup(agentId, options)` creates a `heartbeat_runs` row.
- The heartbeat scheduler polls for queued runs and dispatches to the adapter.
- Adapters do not directly participate in heartbeat scheduling; they are invoked by the heartbeat service.

**Confidence: MEDIUM** — heartbeat service referenced extensively but not directly audited.

---

## 6. Request and Response Format

Agent adapters communicate with their underlying AI systems in adapter-specific formats:
- `claude_local` — Anthropic Messages API
- `codex_local` — OpenAI Chat Completions API
- `http` — Generic HTTP POST with configurable headers/body
- `process` — Spawns a local process, streams stdio

The Paperclip core does not standardize the wire format to the AI system; each adapter handles translation.

**Confidence: MEDIUM** — inferred from adapter type names and `http`/`process` implementations.

---

## 7. Identity and Authentication

### 7.1 Agent API keys
- Stored in `agent_api_keys` table.
- Hashed at rest.
- Used for agent-to-server authentication.
- Scoped to company: `agent_api_keys` has `company_id`.

### 7.2 Adapter authentication
- Built-in adapters use local credentials (API keys stored in agent config).
- External adapters may define their own auth mechanism in `getConfigSchema()`.
- `http` adapter presumably supports header-based auth.

**Confidence: MEDIUM**

---

## 8. Secret Injection

Adapters receive secrets through:
1. Agent config fields (stored in agent record).
2. `company_secrets` resolution at runtime (agents can reference secrets).

There is no adapter-specific secret injection mechanism separate from the general agent secret system.

**Confidence: MEDIUM** — inferred from secret service usage in approval routes and agent config patterns.

---

## 9. Session Persistence

Adapters may implement `AdapterSessionManagement`:
- `encode(session)` / `decode(compacted)` — session compaction/encoding.
- `compact(session)` — reduce session size.
- This is optional; not all adapters support it.

The host stores session data in `agent_task_sessions` or in the run's `contextSnapshot`.

**Confidence: MEDIUM** — types present; exact persistence flow not traced.

---

## 10. Timeout and Retry Handling

### 10.1 Plugin worker timeouts
- Default RPC timeout: 30 seconds
- Max RPC timeout: 5 minutes
- Job timeout: 5 minutes
- Initialize timeout: 15 seconds
- Shutdown drain: 10 seconds

### 10.2 Adapter execution timeouts
Not directly configured in the adapter interface. The heartbeat service likely manages execution timeouts via the run lifecycle.

**Confidence: MEDIUM** — adapter-level timeout not explicitly found.

---

## 11. Auditability

Adapter executions are represented as `heartbeat_runs` rows:
- `status`: `queued`, `running`, `scheduled_retry`, `completed`, `failed`, `cancelled`
- `contextSnapshot`: JSONB including `issueId`
- `error`: failure message
- `startedAt`, `finishedAt`

The `heartbeat_runs` table is company-scoped and linked to `agents`.

**Key symbols:**
- `packages/db/src/schema/heartbeat_runs.ts`

**Confidence: HIGH**

---

## 12. What Paperclip Core Knows About Each Adapter

| Information | Source |
|-------------|--------|
| Type identifier | `ServerAdapterModule.type` |
| Label | `ServerAdapterModule.label` |
| Models | `ServerAdapterModule.models` |
| Config schema | `ServerAdapterModule.getConfigSchema()` |
| Capabilities | `ServerAdapterModule.supportsInstructionsBundle`, `supportsSkills`, `supportsLocalAgentJwt`, `requiresMaterializedRuntimeSkills` |
| UI parser | Optional `./ui-parser` export from package |
| Session management | Optional `ServerAdapterModule.sessionManagement` |

The core does NOT know:
- The adapter's internal wire protocol
- The adapter's credential storage mechanism
- The adapter's retry strategy

**Confidence: HIGH**

---

## 13. Should a Mailbox or Intake Worker Be an Agent Adapter?

**No — an intake worker should NOT be an agent adapter.**

### 13.1 Adapter purpose
Adapters are **execution backends for agents**. They translate Paperclip instructions into agent runs and return results. They are fundamentally about runtime execution.

### 13.2 Intake worker purpose
An intake worker (e.g., email receiver) is about **event ingestion and issue creation**. It does not execute agent instructions. It creates work for agents.

### 13.3 Appropriate extension mechanisms
| Mechanism | Fit for intake |
|-----------|---------------|
| **Plugin** | ✅ Best fit — can declare webhooks, cron jobs, tools, API routes, and use `issues.create` capability |
| **Routine + webhook trigger** | ✅ Good fit — external system POSTs to public webhook URL; routine creates issue and wakes agent |
| **External service + API** | ✅ Good fit — external service polls/creates via Paperclip API |
| **Agent adapter** | ❌ Wrong abstraction — adapters execute agents, they don't create work |

### 13.4 Evidence
- Adapters have no `createIssue` or `receiveWebhook` methods in their interface.
- The `http` adapter is for agent execution over HTTP, not for receiving webhooks.
- Plugins explicitly support `webhooks.receive`, `jobs.schedule`, and `issues.create`.

**Confidence: HIGH**

---

## 14. Architectural Contradictions

### 14.1 Built-in and external adapter types can collide, but the hot-install path rejects builtin overrides while the init path allows them
`server/src/routes/adapters.ts::POST /api/adapters/install` returns `409` if the adapter type is in `BUILTIN_ADAPTER_TYPES`. However, `server/src/adapters/plugin-loader.ts::buildExternalAdapters()` loads all external adapters at startup without the same collision check. If a builtin adapter is also registered externally (e.g., `hermes_local` in this fork), the init path may succeed while the hot-install path fails.

Actually, re-reading: `buildExternalAdapters()` loads external adapters, and the registry's `resolveExternalAdapterRegistration()` handles `overriddenBuiltin`. The `POST /api/adapters/install` checks `BUILTIN_ADAPTER_TYPES.has(adapterModule.type)` and rejects. This means you cannot hot-install an override for a builtin, but you can have one loaded at startup via the external adapter store.

**Severity:** Low — by design for the fork; `hermes_local` externalization is intentional.

### 14.2 Adapter UI parser is loaded at startup but there is no runtime eviction if the parser crashes
The UI parser source is extracted once at load time and cached in `uiParserCache`. If the parser JavaScript is malformed or throws at import time, the adapter may fail to load entirely. There is no graceful fallback (e.g., skipping the parser and registering without UI support).

**Severity:** Low — parser failure is caught and logged; adapter may still load without parser.

### 14.3 External adapter store is a JSON file with no atomic write or corruption recovery
`adapter-plugins.json` is written with `fs.writeFileSync`. There is no temp-file + rename pattern, no checksum, and no corruption recovery. A crash during write could corrupt the store and prevent startup.

**Severity:** Low — file is small; corruption is unlikely but possible.

---

*No other contradictions identified from current evidence.*
