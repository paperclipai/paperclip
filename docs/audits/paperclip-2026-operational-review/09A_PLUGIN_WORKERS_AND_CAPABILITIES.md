# Paperclip Operational Audit 2026 — Sprint 4
## 09A PLUGIN WORKERS AND CAPABILITIES

**Evidence date:** 2026-07-15  
**Scope:** Out-of-process worker isolation, capability permission model, host service surface, runtime sandboxing, secret access rules, and failure boundaries.

---

## 1. Worker Model Summary

Each installed plugin runs in **its own Node.js child process**, forked from the main Paperclip server. The host communicates with the worker via JSON-RPC 2.0 over stdio (NDJSON on stdout/stdin). Worker stderr is captured and forwarded to the host logger.

### Process isolation boundaries
| Boundary | Assurance |
|----------|-----------|
| Memory | Separate process heap; OS-enforced |
| CPU | Shared; no cgroup isolation |
| Filesystem | Worker sees host filesystem; no chroot |
| Network | Allowed via `http.outbound` capability; SSRF-filtered |
| Environment | Minimal controlled env; `process.env` NOT inherited |
| IPC | Only stdio JSON-RPC; no shared memory |

**Key symbols:**
- `server/src/services/plugin-worker-manager.ts::spawnProcess()` — forks with minimal env
- `server/src/services/plugin-worker-manager.ts::handleProcessExit()` — crash recovery

**Confidence: HIGH**

---

## 2. Capability Permission Model

Capabilities are the **mandatory access control** layer for plugins. The model is:

1. **Declaration:** Plugin manifest lists `capabilities: PluginCapability[]`.
2. **Install-time validation:** `validateManifestCapabilities()` ensures every declared feature has its required capability.
3. **Runtime enforcement:** Every worker→host RPC is gated by `assertOperation(manifest, operation)`.

### 2.1 Enforcement location
The enforcement happens in the **host-side RPC handler**, not the worker. If a worker requests an operation whose required capability is missing from the manifest, the host returns a JSON-RPC error with code `CAPABILITY_DENIED` (mapped to bridge error `CAPABILITY_DENIED`).

### 2.2 Operation-to-capability mapping
Defined in `plugin-capability-validator.ts::OPERATION_CAPABILITIES`. Key mappings:

| Operation | Required Capability |
|-----------|-------------------|
| `issues.create` | `issues.create` |
| `issues.update` | `issues.update` |
| `issue.comments.create` | `issue.comments.create` |
| `activity.log` | `activity.log.write` |
| `events.subscribe` | `events.subscribe` |
| `events.emit` | `events.emit` |
| `jobs.schedule` | `jobs.schedule` |
| `webhooks.receive` | `webhooks.receive` |
| `http.request` | `http.outbound` |
| `secrets.resolve` | `secrets.read-ref` |
| `agent.tools.register` | `agent.tools.register` |
| `db.query` | `database.namespace.read` |
| `db.execute` | `database.namespace.write` |
| `db.migrate` | `database.namespace.migrate` |

**Confidence: HIGH**

---

## 3. Host Services Exposed to Plugins

The host builds a `HostServices` object per plugin via `buildHostServices()` in `plugin-host-services.ts`. Services are **scoped to the plugin ID** but operate within the caller's company scope (where applicable).

### 3.1 Config
- `config.get()` → returns `plugin_config.config_json` for this plugin.

### 3.2 State
- `state.get(scopeKind, stateKey, { scopeId?, namespace? })` → reads from `plugin_state`.
- `state.set(...)` → upserts into `plugin_state`.
- `state.delete(...)` → removes from `plugin_state`.

### 3.3 Database
- `db.namespace()` → returns the plugin's allocated namespace name.
- `db.query(sql, params)` → read-only queries in plugin namespace + optional core tables.
- `db.execute(sql, params)` → write queries in plugin namespace only.

### 3.4 Entities
- `entities.upsert({ entityType, scopeKind, scopeId, externalId, title, status, data })` → upserts `plugin_entities`.
- `entities.list({ entityType?, externalId?, limit?, offset? })` → queries `plugin_entities`.

### 3.5 Events
- `events.emit(name, companyId, payload)` → emits `plugin.{pluginKey}.{name}` to the bus.
- `events.subscribe(eventPattern, filter?, handler)` → subscribes to core or plugin events.

### 3.6 HTTP
- `http.fetch({ url, init? })` → SSRF-protected outbound HTTP. Returns `{ status, statusText, headers, body }`.
- Max response body: 200 MB.
- Timeout: 30 seconds.
- DNS timeout: 5 seconds.
- Blocks private/reserved IP ranges.

### 3.7 Secrets
- `secrets.resolve({ secretRef })` → resolves a `company_secrets` UUID to plaintext. Rate-limited and scope-checked.

### 3.8 Activity
- `activity.log({ companyId, message, entityType?, entityId?, metadata? })` → writes to `activity_log` with `actorType: "plugin"`.

### 3.9 Metrics
- `metrics.write({ name, value, tags? })` → writes to `plugin_logs` with `level: "metric"`.

### 3.10 Telemetry
- `telemetry.track({ eventName, dimensions? })` → sends to host telemetry client as `plugin.{pluginKey}.{eventName}`.

### 3.11 Logger
- `logger.log({ level, message, meta? })` → buffered batch insert to `plugin_logs`.

### 3.12 Core domain read/write
Full CRUD-style access to companies, projects, workspaces, issues, comments, agents, goals, costs — each gated by the corresponding capability.

**Confidence: HIGH**

---

## 4. Runtime Sandbox Boundaries

### 4.1 No formal sandbox
There is **no V8 sandbox, no VM2, no QuickJS, no WebAssembly isolation**. Workers are full Node.js processes with access to:
- The host filesystem (read/write wherever the OS user has permissions)
- All Node.js built-ins (`fs`, `net`, `child_process`, etc.)
- Environment variables explicitly passed by the host

### 4.2 What limits exist
| Limit | Implementation |
|-------|---------------|
| SSRF | `validateAndResolveFetchUrl()` blocks private IPs and pins DNS |
| Secret scope | Only config-referenced secret UUIDs resolvable |
| Secret rate limit | 30/min per plugin |
| DB namespace | Plugin SQL runs only in its assigned namespace (enforced at query time) |
| HTTP body | 200 MB max response |
| RPC timeout | Default 30s; max 5 min |
| Log meta | 50 KB max JSON; 10 KB max message |

### 4.3 Trust model
Plugins run with the **same OS privileges as the Paperclip server**. The security model assumes plugins are trusted code (installed by an instance admin). There is no defense against a malicious plugin that bypasses the SDK and uses Node.js built-ins directly.

**Confidence: HIGH** — The implementation is explicit about this trust model.

---

## 5. Secret Injection Rules

1. **No automatic injection:** Secrets are NOT injected as environment variables into the worker process.
2. **On-demand resolution:** The plugin must call `ctx.secrets.resolve(secretRef)` at runtime.
3. **Reference format:** `secretRef` is a UUID pointing to `company_secrets.id`.
4. **Scope enforcement:** The handler extracts all UUID-shaped strings from the plugin's `configJson` (restricted to `format: "secret-ref"` schema paths if schema is declared). Only those UUIDs are resolvable.
5. **Caching:** Allowed refs are cached for 30 seconds per plugin.
6. **Rotation:** Each resolution goes through the secret provider; no long-lived caching of plaintext.

**Confidence: HIGH**

---

## 6. Job Scheduling and Concurrency

### Scheduler guarantees
- **At-most-once per job per tick:** Overlap prevention via `activeJobs` Set and DB query for `running` status.
- **Tick interval:** 30 seconds (configurable).
- **Max concurrent:** 10 jobs across all plugins.
- **Timeout:** 5 minutes per job RPC.
- **Pointer advancement:** Always happens, even on failure.

### No distributed scheduling
The scheduler uses an in-memory `activeJobs` Set and `setInterval`. In a multi-instance deployment, two servers could simultaneously dispatch the same job. The DB-level `running` check provides a best-effort overlap guard, but there is no distributed lock.

**Confidence: HIGH**

---

## 7. Failure Boundaries

| Failure mode | Impact | Recovery |
|-------------|--------|----------|
| Worker crash | Plugin offline; other plugins unaffected | Auto-restart with backoff; max 10 crashes in 10 min |
| Job execution failure | Run marked `failed`; error logged; schedule advances | Next tick will fire next scheduled run |
| Host handler exception | RPC error returned to worker; worker continues | Worker may retry or surface error to operator |
| Plugin infinite loop in job | RPC timeout after 5 min; run marked `failed` | Schedule advances; next tick may try again |
| Plugin memory leak | Worker OOM; host detects crash; backoff restart | Process restarted; state lost unless persisted |
| Scheduler tick failure | Logged; next tick proceeds | No persistent scheduler state beyond `nextRunAt` |

**Confidence: HIGH**

---

## 8. Architectural Contradictions

### 8.1 Capability model allows `agent.tools.register` but the execution path also uses the same capability
`OPERATION_CAPABILITIES` maps both tool registration and tool execution to `agent.tools.register`. There is no separate `agent.tools.execute` capability. A plugin that can register tools can also execute them. This is by design (tools are self-contained) but means capability granularity is coarse.

**Severity:** Low — by design.

### 8.2 Plugin worker receives `databaseNamespace` in initialize params but `pluginDb.getRuntimeNamespace()` queries the DB every time
The namespace is passed at init, but the host service re-derives it from the DB on each `db.namespace()` call. This is safe but redundant.

**Severity:** Negligible.

### 8.3 The `plugin.state` API allows `instance` scope with `scopeId: null`, but the `plugin_entities` table requires `scopeId` to be nullable for global scope, yet many entity queries may not handle `null` scopeId correctly in filters
The schema supports it, but the `entities.list()` implementation in `plugin-host-services.ts` delegates to `pluginRegistryService.listEntities()`, which applies the filter params. If a plugin uses `scopeId: null` with `scopeKind: "instance"`, the query should work because `null` is a valid value. However, UI integrations that display entity mappings might not account for null `scopeId`.

**Severity:** Low — edge case in usage, not implementation.

---

*No other contradictions identified from current evidence.*
