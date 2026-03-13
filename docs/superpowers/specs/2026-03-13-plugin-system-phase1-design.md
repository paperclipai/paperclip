# Plugin System Phase 1 — Design Spec

**Date:** 2026-03-13
**Status:** Draft
**Scope:** Phase 1 — Plugin loader, out-of-process workers, cron jobs, event bus, SDK proxy, agent tools, CLI, plugin creator skill

## 1. Overview

Paperclip's plugin system lets operators extend the control plane with scheduled jobs, event-driven automation, custom agent tools, and HTTP endpoints — without modifying Paperclip core.

Phase 1 delivers the foundational runtime: plugin loading, out-of-process worker management, a capability-gated SDK, cron job scheduling, an event bus, agent tool registration, HTTP route forwarding, CLI commands, and a plugin creator skill.

### 1.1 Goals

1. Let plugins assign tasks to specific agents programmatically.
2. Let plugins wake specific agents on demand with context/payload.
3. Let plugins run scheduled jobs (cron) that persist across server restarts.
4. Let plugins react to core lifecycle events (agent runs, issue changes, approvals).
5. Let plugins register custom tools that agents can invoke.
6. Let plugins expose HTTP endpoints for external integrations.
7. Keep plugins isolated — a bad plugin cannot crash the server.
8. Use TDD/BDD approach for all implementation.

### 1.2 Non-Goals (Phase 2)

- UI extension slots (pages, tabs, widgets, sidebar)
- Plugin settings UI (auto-generated forms from JSON Schema)
- Hot reload without server restart (Phase 1 requires server restart for install/uninstall/upgrade)
- Plugin-to-plugin communication
- Marketplace / Company Store
- Out-of-process iframe sandboxing for plugin UI
- Webhook declarations (plugins handle webhooks via routes in Phase 1)

### 1.3 Primary Use Cases

**PA Scheduler Plugin:** Declares cron jobs (e.g. daily 8am NotebookLM sync). When a job fires, the plugin wakes the Personal Assistant agent with a specific instruction or creates a task assigned to it.

**Monitoring Plugin:** Subscribes to `agent.run.failed` and `agent.budget.threshold` events. When triggered, creates a high-priority task assigned to a specific agent or wakes an agent to investigate.

---

## 2. Architecture

### 2.1 Process Model

Plugins run **out-of-process** as separate Node.js child processes. Communication uses **JSON-RPC 2.0 over stdio** (stdin/stdout). Stderr is captured for logging.

Each installed plugin gets one worker process. The host (Paperclip server) manages spawning, health checks, restart, and shutdown of all workers.

### 2.2 On-Disk Layout

```
~/.paperclip/instances/default/plugins/
  package.json                          # npm workspace root for plugins
  node_modules/
    @paperclip/
      plugin-pa-scheduler/
        package.json
        dist/
          manifest.js                   # plugin identity + declarations
          worker.js                     # entrypoint the host spawns
```

### 2.3 Host Components

Four new server-side components:

```
Server startup
  -> Plugin Loader (scan, validate, sync DB)
    -> Process Manager (spawn workers, send initialize)
      -> Job Scheduler (start ticking)
      -> Event Bus (ready to route)

Runtime:
  Cron tick -> Job Scheduler -> runJob RPC -> Worker -> ctx.agents.wakeup() -> Host fulfills
  Issue created -> Event Bus -> onEvent RPC -> Worker -> ctx.issues.create() -> Host fulfills
  Agent calls tool -> Host -> executeTool RPC -> Worker -> returns result
  HTTP request -> Express route -> handleRequest RPC -> Worker -> returns response
```

---

## 3. Package Structure & Manifest

A plugin is an npm package with a `paperclipPlugin` key in `package.json`:

```json
{
  "name": "@paperclip/plugin-pa-scheduler",
  "version": "1.0.0",
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js"
  }
}
```

### 3.1 Manifest Schema

```typescript
export interface PaperclipPluginManifestV1 {
  id: string;                              // unique plugin identifier
  apiVersion: 1;                           // manifest schema version
  version: string;                         // semver
  displayName: string;
  description: string;
  categories: Array<"connector" | "workspace" | "automation" | "ui">;
  minimumPaperclipVersion?: string;        // semver constraint (optional)
  capabilities: string[];                  // required capabilities (see §4.2 for full list)
  entrypoints: {
    worker: string;                        // path to worker.js
  };
  instanceConfigSchema?: JsonSchema;       // JSON Schema for config
  jobs?: Array<{
    id: string;
    displayName: string;
    cron: string;                          // 5-field cron expression
  }>;
  events?: string[];                       // events to subscribe to
  tools?: Array<{
    name: string;
    displayName: string;
    description: string;
    parametersSchema: JsonSchema;
  }>;
}
```

### 3.2 Manifest Example

```typescript
export const manifest: PaperclipPluginManifestV1 = {
  id: "@paperclip/plugin-pa-scheduler",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "PA Scheduler",
  description: "Scheduled jobs that wake the Personal Assistant",
  categories: ["automation"],
  capabilities: [
    "issues.create", "issues.read",
    "issue.comments.create",
    "agents.read", "agents.wakeup",
    "events.subscribe", "jobs.schedule",
    "plugin.state.read", "plugin.state.write"
  ],
  entrypoints: { worker: "./worker.js" },
  instanceConfigSchema: {
    type: "object",
    properties: {
      targetAgentName: { type: "string", default: "personal-assistant" },
      defaultCompanyId: { type: "string" }
    },
    required: ["defaultCompanyId"]
  },
  jobs: [
    { id: "notebooklm-sync", displayName: "NotebookLM Sync", cron: "57 7 * * *" },
    { id: "morning-briefing", displayName: "Morning Briefing", cron: "0 8 * * 1-5" }
  ],
  events: [
    "agent.run.failed", "agent.run.finished", "agent.budget.threshold"
  ]
};
```

---

## 4. Host-Worker Protocol

JSON-RPC 2.0 over stdio. Newline-delimited messages.

### 4.1 Host -> Worker (RPC calls from host)

| Method | Required | When Called |
|--------|----------|------------|
| `initialize` | Yes | Once on startup. Params: `{ pluginId, manifest, config }`. `pluginId` is the DB UUID; `manifest.id` is the npm package name (plugin_key). Both are provided so the worker can identify itself. |
| `health` | Yes | Periodic health check (every 30s). Returns: `{ status: "ok" }` |
| `shutdown` | Yes | Graceful shutdown. Worker has 10s to clean up. |
| `configChanged` | No | When operator updates config in DB. Params: `{ config }` |
| `onEvent` | No | When a subscribed event fires. Params: `{ name, payload, timestamp }` |
| `runJob` | No | When a declared cron job fires. Params: `{ jobKey, triggerSource, runId }` |
| `handleRequest` | No | When an HTTP request hits the plugin's route prefix. Params: `{ method, path, headers, query, body }` |
| `executeTool` | No | When an agent invokes a plugin-registered tool. Params: `{ toolName, parameters, runContext }` |

### 4.2 Worker -> Host (SDK calls from worker)

| SDK Method | Capability Required | Description |
|------------|-------------------|-------------|
| `issues.create` | `issues.create` | Create a task assigned to an agent |
| `issues.read` | `issues.read` | Read an issue by ID |
| `issues.update` | `issues.update` | Update status, assignee, etc. |
| `issues.list` | `issues.read` | List issues with filters |
| `issues.addComment` | `issue.comments.create` | Add a comment to an issue |
| `agents.list` | `agents.read` | List agents in a company |
| `agents.read` | `agents.read` | Get agent by ID |
| `agents.wakeup` | `agents.wakeup` | Wake an agent with context/payload |
| `events.emit` | `events.emit` | Emit a custom event |
| `state.get` | `plugin.state.read` | Read plugin-scoped key-value state |
| `state.set` | `plugin.state.write` | Write plugin-scoped key-value state (max 1MB per value) |
| `state.delete` | `plugin.state.write` | Delete a state key |
| `config.get` | _(always allowed)_ | Read own config |
| `logger.debug` | _(always allowed)_ | Structured log (debug level) |
| `logger.info` | _(always allowed)_ | Structured log (info level) |
| `logger.warn` | _(always allowed)_ | Structured log (warn level) |
| `logger.error` | _(always allowed)_ | Structured log (error level) |

**Implicit capabilities** (required by manifest declarations, not SDK calls):

| Declaration | Capability Required | Description |
|-------------|-------------------|-------------|
| `manifest.tools` | `agent.tools.register` | Plugin contributes agent tools |
| `manifest.routes` handler | `routes.handle` | Plugin exposes HTTP endpoints |
| `manifest.jobs` | `jobs.schedule` | Plugin declares cron jobs |
| `manifest.events` | `events.subscribe` | Plugin subscribes to events |

### 4.3 Capability Enforcement

Before executing any Worker -> Host call, the host checks the plugin's `manifest.capabilities` array. If the required capability is not listed, the host returns:

```json
{"jsonrpc":"2.0","id":100,"error":{"code":-32600,"message":"capability 'agents.wakeup' not granted"}}
```

### 4.4 Actor Identity

All mutations made by a plugin are attributed to:
- `actorType: "plugin"`
- `actorId: <pluginId>`

This keeps the audit trail clean.

### 4.5 Example Exchange

```
# Host -> Worker: initialize
-> {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"pluginId":"...","manifest":{...},"config":{"targetAgentName":"personal-assistant"}}}
<- {"jsonrpc":"2.0","id":1,"result":{"ok":true}}

# Host -> Worker: runJob (cron fired)
-> {"jsonrpc":"2.0","id":2,"method":"runJob","params":{"jobKey":"notebooklm-sync","triggerSource":"schedule","runId":"..."}}

# Worker -> Host: agents.wakeup (inside the job handler)
<- {"jsonrpc":"2.0","id":100,"method":"agents.wakeup","params":{"agentId":"...","reason":"scheduled_job","payload":{"instruction":"Run /paperclip-notebooklm-sync"}}}
-> {"jsonrpc":"2.0","id":100,"result":{"ok":true}}

# Worker responds to runJob
<- {"jsonrpc":"2.0","id":2,"result":{"ok":true}}
```

---

## 5. Database Schema

Six new tables:

### 5.1 plugins

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `plugin_key` | TEXT UNIQUE NOT NULL | e.g. `@paperclip/plugin-pa-scheduler` |
| `display_name` | TEXT NOT NULL | |
| `version` | TEXT NOT NULL | |
| `status` | TEXT NOT NULL | `installed`, `ready`, `error`, `uninstalled`, `upgrade_pending` |
| `capabilities` | TEXT[] NOT NULL | |
| `manifest` | JSONB NOT NULL | full manifest snapshot |
| `install_path` | TEXT NOT NULL | absolute path to plugin package |
| `last_error` | TEXT | |
| `created_at` | TIMESTAMPTZ NOT NULL | |
| `updated_at` | TIMESTAMPTZ NOT NULL | |

### 5.2 plugin_config

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `plugin_id` | UUID FK UNIQUE NOT NULL | one config per plugin |
| `config_json` | JSONB NOT NULL | validated against manifest schema |
| `updated_at` | TIMESTAMPTZ NOT NULL | |

### 5.3 plugin_state

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `plugin_id` | UUID FK NOT NULL | |
| `scope` | TEXT NOT NULL | `global`, or entity-scoped like `company:<id>`, `project:<id>` |
| `key` | TEXT NOT NULL | |
| `value` | JSONB NOT NULL | |
| `updated_at` | TIMESTAMPTZ NOT NULL | |
| | UNIQUE | `(plugin_id, scope, key)` |

### 5.4 plugin_jobs

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `plugin_id` | UUID FK NOT NULL | |
| `job_key` | TEXT NOT NULL | e.g. `notebooklm-sync` |
| `display_name` | TEXT NOT NULL | |
| `cron` | TEXT NOT NULL | 5-field cron expression |
| `enabled` | BOOLEAN NOT NULL DEFAULT true | |
| `last_run_at` | TIMESTAMPTZ | |
| `next_run_at` | TIMESTAMPTZ | |
| | UNIQUE | `(plugin_id, job_key)` |

### 5.5 plugin_job_runs

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `job_id` | UUID FK NOT NULL | |
| `plugin_id` | UUID FK NOT NULL | |
| `status` | TEXT NOT NULL | `running`, `completed`, `failed`, `cancelled` |
| `started_at` | TIMESTAMPTZ NOT NULL | |
| `completed_at` | TIMESTAMPTZ | |
| `error` | TEXT | |
| `result` | JSONB | |

### 5.6 plugin_tools

| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID PK | |
| `plugin_id` | UUID FK NOT NULL | |
| `tool_name` | TEXT NOT NULL | e.g. `pa-scheduler:list-jobs` |
| `display_name` | TEXT NOT NULL | |
| `description` | TEXT NOT NULL | |
| `parameters_schema` | JSONB NOT NULL | JSON Schema for tool params |
| `enabled` | BOOLEAN NOT NULL DEFAULT true | |
| | UNIQUE | `(plugin_id, tool_name)` |

### 5.7 Phase 1 Schema Divergences from PLUGIN_SPEC.md

The following are deliberate Phase 1 simplifications. Migration paths are noted for Phase 2:

| Area | PLUGIN_SPEC.md | Phase 1 Design | Migration Path |
|------|---------------|----------------|----------------|
| `plugin_state.scope` | Structured: `scope_kind` enum + `scope_id` | Freeform TEXT (`global`, `company:<id>`) | Add `scope_kind`/`scope_id` columns, migrate from TEXT format |
| `plugin_jobs.schedule` | Column named `schedule`, has `status` enum | Column named `cron`, uses `enabled` boolean | Rename column, add status enum |
| `plugin_job_runs.status` | `queued`, `running`, `succeeded`, `failed`, `cancelled` + `trigger` column | `running`, `completed`, `failed`, `cancelled` | Rename `completed` → `succeeded`, add `trigger` column |
| Event delivery | At-least-once with idempotency | Fire-and-forget (at-most-once) | Add event persistence + retry queue |
| SDK entry | `definePlugin()` returning `PaperclipPlugin` | `createPluginWorker()` returning `void` | May adopt declarative API in Phase 2 |
| `plugins` table | Has `package_name`, `api_version`, `categories`, `install_order` columns | These are stored in `manifest` JSONB only | Promote to top-level columns if query patterns require it |

---

## 6. Host Components

### 6.1 Plugin Loader (`server/src/plugins/loader.ts`)

Runs on server startup:

1. Scans `~/.paperclip/instances/default/plugins/node_modules/` for packages with `paperclipPlugin` in their `package.json`
2. Reads and validates each manifest against `PaperclipPluginManifestV1` schema (using Zod)
3. Upserts plugin record into `plugins` table
4. Syncs declared jobs into `plugin_jobs` table (add new, remove stale, preserve `enabled` state)
5. Syncs declared tools into `plugin_tools` table
6. Hands off to Process Manager to spawn workers

### 6.2 Process Manager (`server/src/plugins/process-manager.ts`)

Owns the lifecycle of all plugin worker processes:

- **Spawn**: `node <install_path>/dist/worker.js` with stdio pipes
- **RPC Channel**: bidirectional JSON-RPC over stdin/stdout, request/response tracking with per-method timeouts:
  - `initialize`: 30s (plugin setup may involve async work)
  - `health`: 5s
  - `shutdown`: 10s
  - `runJob`: 300s (5min — jobs may do substantial work)
  - `onEvent`: 30s
  - `handleRequest`: 30s
  - `executeTool`: 60s
  - `configChanged`: 10s
  - Worker -> Host SDK calls: 30s default
- **Initialize**: sends `initialize` RPC with manifest + config, marks plugin `ready` on success or `error` on failure
- **Health**: periodic `health` RPC every 30s, marks plugin `error` after 3 consecutive failures
- **Restart**: auto-restart on crash with exponential backoff (1s, 2s, 4s, 8s, max 30s), resets backoff after 60s of healthy operation. **Circuit breaker**: after 5 consecutive restart failures within 5 minutes, the plugin is marked `error` and restarts stop. The operator must manually re-enable via `plugin doctor` or server restart.
- **Shutdown**: `shutdown` RPC -> 10s deadline -> SIGTERM -> 5s -> SIGKILL
- **Registry**: `Map<pluginId, { process, status, rpcChannel }>` for routing calls to the right worker

### 6.3 Event Bus (`server/src/plugins/event-bus.ts`)

Simple pub-sub:

- Maintains a subscription map: `Map<eventName, Set<pluginId>>` built from plugin manifests
- Core Paperclip code calls `eventBus.emit(name, payload)` at lifecycle points
- Event bus delivers to subscribed workers via `onEvent` RPC
- Fire-and-forget delivery: if a worker is down, the event is logged but not queued/retried
- **Concurrency**: Events are delivered serially per plugin (one `onEvent` at a time per worker). If a worker is still processing a previous event when a new one arrives, the new event is queued in-memory and delivered after the current handler completes. This prevents race conditions in plugin state.
- Events include a timestamp and source metadata

Events emitted from core:

| Event | Source File | Payload |
|-------|-----------|---------|
| `agent.run.started` | `heartbeat.ts` | `{ agentId, agentName, runId, reason, companyId }` |
| `agent.run.finished` | `heartbeat.ts` | `{ agentId, agentName, runId, durationMs, companyId }` |
| `agent.run.failed` | `heartbeat.ts` | `{ agentId, agentName, runId, error, companyId }` |
| `agent.budget.threshold` | budget check | `{ agentId, agentName, percentUsed, limitCents, companyId }` |
| `issue.created` | `issues.ts` | `{ issueId, companyId, title, assigneeAgentId, assigneeUserId }` |
| `issue.updated` | `issues.ts` | `{ issueId, companyId, changes: { field, from, to }[], actorType, actorId }` |
| `issue.comment.created` | `issues.ts` | `{ issueId, companyId, commentId, authorAgentId, authorUserId }` |
| `approval.created` | `approvals.ts` | `{ approvalId, companyId, issueIds }` |
| `approval.decided` | `approvals.ts` | `{ approvalId, companyId, decision, decisionNote }` |

### 6.4 Job Scheduler (`server/src/plugins/job-scheduler.ts`)

Cron runner for plugin-declared jobs:

- On startup, reads all enabled jobs from `plugin_jobs` and calculates `next_run_at` using `cron-parser`
- Ticks every 15s (added to server's existing interval loop, same pattern as heartbeat scheduler)
- When `now >= next_run_at`:
  1. Creates a `plugin_job_runs` record with status `running`
  2. Sends `runJob` RPC to the worker
  3. On success: marks run `completed`, updates `last_run_at` and `next_run_at`
  4. On failure: marks run `failed` with error message
- If the worker is down, marks the run as `failed` immediately
- Skips a job if the previous run is still `running` (no overlapping runs)
- **Missed ticks**: If the server was down when a job was due, on next startup the scheduler calculates `next_run_at` from the current time (not from the missed time). Missed jobs are not retroactively executed — cron semantics are "run at the next matching time," not "ensure every tick fires."

### 6.5 SDK Proxy (`server/src/plugins/sdk-proxy.ts`)

Handles Worker -> Host RPC calls:

1. Receives JSON-RPC request from worker
2. Looks up required capability for the method
3. Checks plugin's `manifest.capabilities` array
4. If denied: returns JSON-RPC error `-32600`
5. If allowed: calls the real Paperclip service (issues, heartbeat, etc.)
6. Returns result to worker

All mutations use actor identity `{ actorType: "plugin", actorId: pluginId }`.

### 6.6 Plugin Routes (`server/src/plugins/routes.ts`)

Express catch-all mounted at `/api/plugins/:pluginId/*`:

1. Extracts `pluginId` and sub-path from URL
2. **Authentication**: Plugin routes are behind the same JWT auth middleware as core API routes. The request's `Authorization: Bearer <token>` is validated by the host. Unauthenticated requests receive `401`. The worker receives the authenticated user/agent identity in the `handleRequest` params (as `auth: { userId?, agentId?, actorType }`) but never sees the raw JWT.
3. Finds the worker via Process Manager (returns `503` if worker is down)
4. Forwards request to worker via `handleRequest` RPC: `{ method, path, headers, query, body, params, auth }`
   - `path` is the sub-path after `/api/plugins/:pluginId/` (e.g., `/jobs` for a request to `/api/plugins/@test/foo/jobs`)
   - `params` contains path parameters extracted from the sub-path (e.g., `{ jobKey: "sync" }` for `/jobs/:jobKey/trigger`)
5. The **worker** is responsible for routing `method + path` to the correct handler. The SDK's `createPluginWorker` matches the `routes` map keys (e.g., `"GET /jobs"`, `"POST /jobs/:jobKey/trigger"`) using a simple path-matching utility included in the SDK.
6. Returns worker's response to the HTTP client. The worker returns `{ status, headers?, body }` and the host translates this to the Express response.

---

## 7. Plugin SDK Package

New package: `packages/plugin-sdk/` (`@paperclipai/plugin-sdk`)

### 7.1 Exports

```typescript
// Main export
export function createPluginWorker(handlers: PluginWorkerHandlers): void;

// Types
export interface PluginWorkerHandlers {
  initialize(ctx: PluginContext): Promise<void>;
  health(): Promise<{ status: string }>;
  shutdown(): Promise<void>;
  configChanged?(ctx: PluginContext, config: Record<string, unknown>): Promise<void>;
  jobs?: Record<string, (ctx: PluginContext, job: JobContext) => Promise<void>>;
  events?: Record<string, (ctx: PluginContext, event: EventPayload) => Promise<void>>;
  routes?: Record<string, (ctx: PluginContext, req: PluginRequest) => Promise<PluginResponse>>;
  tools?: Record<string, PluginToolDefinition>;
}

export interface PluginContext {
  issues: {
    create(input: IssueCreateInput): Promise<Issue>;
    read(issueId: string): Promise<Issue>;
    update(issueId: string, input: IssueUpdateInput): Promise<Issue>;
    list(companyId: string, filter?: IssueFilter): Promise<Issue[]>;
    addComment(issueId: string, body: string): Promise<Comment>;
  };
  agents: {
    list(companyId: string): Promise<Agent[]>;
    read(agentId: string): Promise<Agent>;
    wakeup(agentId: string, input: WakeupInput): Promise<void>;
  };
  events: {
    emit(name: string, payload: Record<string, unknown>): Promise<void>;
  };
  state: {
    get(scope: string, key: string): Promise<unknown | null>;
    set(scope: string, key: string, value: unknown): Promise<void>;
    delete(scope: string, key: string): Promise<void>;
  };
  config: {
    get(): Promise<Record<string, unknown>>;
  };
  logger: {
    debug(message: string, data?: Record<string, unknown>): void;
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
  };
}

export interface JobContext {
  jobKey: string;
  triggerSource: "schedule" | "manual";
  runId: string;
}

export interface EventPayload {
  name: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface WakeupInput {
  reason: string;
  payload?: Record<string, unknown>;
  context?: Record<string, unknown>;
}

export interface PluginToolDefinition {
  description: string;
  parameters: JsonSchema;
  handler(ctx: PluginContext, params: Record<string, unknown>, runContext: ToolRunContext): Promise<ToolResult>;
}

export interface PluginRequest {
  method: string;                          // HTTP method (GET, POST, etc.)
  path: string;                            // sub-path after plugin prefix
  headers: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  params: Record<string, string>;          // path parameters (e.g., :id)
  auth: {
    userId?: string;
    agentId?: string;
    actorType: "user" | "agent" | "system";
  };
}

export interface PluginResponse {
  status: number;                          // HTTP status code
  headers?: Record<string, string>;
  body: unknown;                           // JSON-serializable response body
}

export interface ToolRunContext {
  agentId: string;
  agentName: string;
  runId: string;
  companyId: string;
  projectId?: string;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;                          // JSON-serializable result data
  error?: string;                          // error message if success=false
}
```

**Note:** Domain types (`Issue`, `IssueCreateInput`, `IssueUpdateInput`, `IssueFilter`, `Comment`, `Agent`, `JsonSchema`) are re-exported from `@paperclipai/types` (existing package) or defined in `packages/plugin-sdk/src/types.ts` as simplified interfaces mirroring the core models.

### 7.2 Internal Implementation

`createPluginWorker` does:

1. Sets up stdin/stdout JSON-RPC channel
2. Builds the `PluginContext` object (each method sends an RPC request to host and awaits response)
3. Routes incoming host RPC calls (`initialize`, `runJob`, `onEvent`, etc.) to the handler functions
4. Handles process signals (SIGTERM -> calls `shutdown` handler)

The package is ~200-300 lines. No runtime dependencies beyond JSON-RPC framing.

---

## 8. CLI Commands

New subcommands added to the Paperclip CLI:

### 8.1 Commands

```bash
# List installed plugins with status
pnpm paperclipai plugin list

# Install a plugin (local path or npm package)
pnpm paperclipai plugin install ./my-plugin
pnpm paperclipai plugin install @paperclip/plugin-pa-scheduler

# Uninstall (soft-delete, 30-day data retention)
pnpm paperclipai plugin uninstall @paperclip/plugin-pa-scheduler

# Upgrade a plugin (re-reads manifest, syncs DB, respawns worker)
pnpm paperclipai plugin upgrade @paperclip/plugin-pa-scheduler
# If local path: re-reads from disk. If npm: runs npm update.
# If the new manifest adds capabilities, enters upgrade_pending and prompts for approval.

# Update plugin config
pnpm paperclipai plugin config @paperclip/plugin-pa-scheduler '{"targetAgentName":"personal-assistant"}'

# Check health and diagnostics
pnpm paperclipai plugin doctor @paperclip/plugin-pa-scheduler

# Force purge all data (after uninstall)
pnpm paperclipai plugin purge @paperclip/plugin-pa-scheduler
```

### 8.2 Install Flow

1. If local path: symlink into plugins `node_modules/`
2. If npm package: `npm install` into plugins directory
3. Read and validate manifest
4. Reject incompatible `apiVersion`
5. Insert record into `plugins` table with status `installed`
6. Set initial config from `instanceConfigSchema` defaults into `plugin_config`
7. Sync jobs and tools into `plugin_jobs` and `plugin_tools`
8. Print "Plugin installed. Restart the server to activate."

**Note:** In Phase 1, plugins are activated on server startup only. The install CLI prepares the DB records and on-disk files, but the worker is not spawned until the next server restart. Phase 2 will add hot-reload (spawn without restart).

### 8.3 Upgrade Flow

1. If local path: re-read manifest from disk
2. If npm package: `npm update` in plugins directory
3. Re-validate manifest
4. Compare capabilities: if new capabilities added, mark plugin `upgrade_pending` and prompt operator for approval
5. Update `plugins` record (version, manifest, capabilities)
6. Re-sync jobs and tools
7. Print "Plugin upgraded. Restart the server to activate."

### 8.4 Uninstall Flow

1. Send `shutdown` RPC to worker (graceful shutdown policy)
2. Mark plugin status `uninstalled` in `plugins` table (soft delete)
3. Plugin data (`plugin_state`, `plugin_config`, `plugin_jobs`, `plugin_job_runs`, `plugin_tools`) retained for 30-day grace period
4. Operator can reinstall same plugin within grace period and recover state
5. After grace period or manual `purge`: delete all plugin data

---

## 9. File Layout

### 9.1 New Files

```
packages/
  plugin-sdk/
    package.json
    tsconfig.json
    src/
      index.ts                             # exports createPluginWorker + types
      rpc.ts                               # JSON-RPC framing over stdio
      types.ts                             # PluginManifestV1, PluginContext, etc.

server/src/plugins/
  index.ts                                 # init() called from server startup
  loader.ts                                # scan, validate manifests, sync DB
  process-manager.ts                       # spawn/kill/restart workers, RPC channel
  event-bus.ts                             # pub-sub, route events to workers
  job-scheduler.ts                         # cron tick loop, trigger runJob
  sdk-proxy.ts                             # handle worker->host RPC calls
  routes.ts                                # Express catch-all for plugin HTTP
  types.ts                                 # shared host-side types

server/src/cli/
  plugins.ts                               # CLI subcommands

packages/db/src/schema/
  plugins.ts                               # Drizzle schema for 6 tables

packages/db/src/migrations/
  XXXX_add_plugins.ts                      # Migration for plugin tables
```

### 9.2 Modified Files

| File | Change |
|------|--------|
| `server/src/index.ts` | Import and call `plugins.init()` after server starts; add job scheduler interval |
| `server/src/app.ts` | Mount plugin routes: `app.all('/api/plugins/:pluginId/*', ...)` |
| `server/src/services/heartbeat.ts` | Add `eventBus.emit(...)` at run start/complete/fail points |
| `server/src/routes/issues.ts` | Add `eventBus.emit(...)` after issue create/update/comment |
| `server/src/routes/approvals.ts` | Add `eventBus.emit(...)` after approval create/decide |
| `packages/db/src/schema/index.ts` | Export new plugin tables |
| `package.json` (root) | Add `packages/plugin-sdk` to pnpm workspace |

### 9.3 Server Startup Sequence

```
Server starts (index.ts)
  -> DB migrations run (includes plugin tables)
  -> Core services initialize (heartbeat, issues, etc.)
  -> Event bus initializes
  -> Plugin loader scans + validates + syncs DB
  -> Process manager spawns workers + sends initialize
  -> Job scheduler loads jobs from DB + starts ticking
  -> Express routes mounted (including plugin catch-all)
  -> Server ready
```

### 9.4 Server Shutdown Sequence

```
Server receives SIGTERM/SIGINT
  -> Job scheduler stops ticking
  -> Process manager sends shutdown to all workers (10s deadline)
  -> Workers that don't exit: SIGTERM (5s) then SIGKILL
  -> In-flight job runs marked "cancelled"
  -> Core services shut down
  -> DB connections close
```

---

## 10. Plugin Creator Skill

A new skill `/paperclip-plugin-creator` that guides the user through creating a new plugin, similar to `/paperclip-agent-creator`.

### 10.1 Flow

1. Ask plugin name, description, category
2. Ask which capabilities it needs (show list with descriptions)
3. Ask about cron jobs (name, cron expression for each)
4. Ask about event subscriptions (show available events)
5. Ask about agent tools (name, description, parameters for each)
6. Ask about HTTP routes (yes/no)
7. Generate manifest, worker scaffold, package.json, tsconfig.json
8. Run `plugin install` to install locally
9. Verify with `plugin doctor`

### 10.2 Generated Scaffold

The skill generates a complete, working plugin with:

- `package.json` with `@paperclipai/plugin-sdk` dependency
- `tsconfig.json` for TypeScript compilation
- `src/manifest.ts` with filled-in manifest
- `src/worker.ts` with stub handlers for declared jobs/events/tools/routes
- `scripts/build.sh` to compile TypeScript

---

## 11. Worker Example (PA Scheduler Plugin)

```typescript
import { createPluginWorker, PluginContext } from "@paperclipai/plugin-sdk";

let config: Record<string, unknown>;
let paAgentId: string;

createPluginWorker({
  async initialize(ctx: PluginContext) {
    config = await ctx.config.get();

    // Resolve PA agent ID from name
    const agents = await ctx.agents.list(config.defaultCompanyId as string);
    const pa = agents.find(a => a.name === config.targetAgentName);
    if (!pa) throw new Error(`Agent "${config.targetAgentName}" not found`);
    paAgentId = pa.id;

    ctx.logger.info("PA Scheduler initialized", { paAgentId });
  },

  async health() {
    return { status: "ok" };
  },

  async shutdown() {
    // nothing to clean up
  },

  jobs: {
    "notebooklm-sync": async (ctx, job) => {
      await ctx.agents.wakeup(paAgentId, {
        reason: "scheduled_job",
        payload: { instruction: "Run /paperclip-notebooklm-sync" }
      });
      ctx.logger.info("Woke PA for NotebookLM sync", { jobKey: job.jobKey });
    },

    "morning-briefing": async (ctx, job) => {
      await ctx.issues.create({
        companyId: config.defaultCompanyId as string,
        title: "Morning briefing - list today's tasks",
        description: "Use gws tasks to list all tasks due today. Summarize and post results.",
        assigneeAgentId: paAgentId,
        status: "todo"
      });
      ctx.logger.info("Created morning briefing task for PA");
    }
  },

  events: {
    "agent.run.failed": async (ctx, event) => {
      await ctx.issues.create({
        companyId: event.payload.companyId as string,
        title: `Alert: ${event.payload.agentName} run failed`,
        description: `Run ${event.payload.runId} failed.\n\nError: ${event.payload.error}`,
        assigneeAgentId: paAgentId,
        status: "todo",
        priority: "high"
      });
      ctx.logger.warn("Created alert task for agent run failure", {
        failedAgent: event.payload.agentName
      });
    },

    "agent.run.finished": async (ctx, event) => {
      // Log for observability, no action needed
      ctx.logger.info("Agent run finished", {
        agent: event.payload.agentName,
        durationMs: event.payload.durationMs
      });
    },

    "agent.budget.threshold": async (ctx, event) => {
      await ctx.issues.create({
        companyId: event.payload.companyId as string,
        title: `Budget alert: ${event.payload.agentName} at ${event.payload.percentUsed}%`,
        description: `Agent ${event.payload.agentName} has used ${event.payload.percentUsed}% of its monthly budget (${event.payload.limitCents} cents).`,
        assigneeAgentId: paAgentId,
        status: "todo",
        priority: "high"
      });
    }
  },

  routes: {
    "GET /jobs": async (ctx) => {
      const history = await ctx.state.get("global", "job-history");
      return { status: 200, body: history ?? [] };
    },
    "POST /jobs/:jobKey/trigger": async (ctx, req) => {
      // Manual trigger handled by host - just acknowledge
      return { status: 200, body: { ok: true, triggered: req.params?.jobKey } };
    }
  }
});
```

---

## 12. Testing Strategy

### 12.1 BDD Acceptance Tests

Written before implementation. Each scenario is an end-to-end test.

**Feature: Plugin Installation**
```gherkin
Scenario: Install a valid plugin
  Given a plugin package at "./test-fixtures/valid-plugin"
  When I run "pnpm paperclipai plugin install ./test-fixtures/valid-plugin"
  Then the plugins table has a record with status "ready"
  And the plugin worker process is running
  And "plugin doctor" returns status "ok"

Scenario: Reject plugin with invalid manifest
  Given a plugin package with missing "id" field
  When I run "pnpm paperclipai plugin install ./test-fixtures/invalid-plugin"
  Then the install fails with error "manifest validation failed"
  And no record exists in the plugins table

Scenario: Uninstall a plugin
  Given an installed plugin "@test/plugin-foo"
  When I run "pnpm paperclipai plugin uninstall @test/plugin-foo"
  Then the plugin status is "uninstalled"
  And the worker process has exited
  And plugin data is retained (not purged)
```

**Feature: Cron Job Execution**
```gherkin
Scenario: Cron job fires and wakes an agent
  Given a plugin with job "sync" cron "* * * * *" (every minute)
  And the job handler calls ctx.agents.wakeup(agentId)
  When the job scheduler ticks past the next_run_at
  Then a plugin_job_runs record is created with status "running"
  And the worker receives a "runJob" RPC with jobKey "sync"
  And heartbeat.wakeup() is called for the target agent
  And the job run status is updated to "completed"

Scenario: Cron job fails gracefully
  Given a plugin with job "broken" whose handler throws an error
  When the job fires
  Then the job run status is "failed"
  And the error is recorded in plugin_job_runs.error
  And the plugin remains in "ready" status (not crashed)
```

**Feature: Event Delivery**
```gherkin
Scenario: Plugin receives agent.run.failed event
  Given a plugin subscribed to "agent.run.failed"
  And the plugin is in "ready" status
  When an agent run fails in heartbeat.ts
  Then the worker receives an "onEvent" RPC
  And the event payload contains agentId, runId, and error

Scenario: Event delivery when worker is down
  Given a plugin subscribed to "issue.created"
  And the plugin worker has crashed
  When an issue is created
  Then the event is logged as undeliverable
  And no error is raised in the core issue creation flow
```

**Feature: Agent Tool Invocation**
```gherkin
Scenario: Agent invokes a plugin-registered tool
  Given a plugin that registers tool "list-jobs"
  And an agent run is active
  When the agent calls tool "pa-scheduler:list-jobs"
  Then the worker receives an "executeTool" RPC
  And the tool result is returned to the agent

Scenario: Capability denied
  Given a plugin without "agents.wakeup" capability
  When the worker calls ctx.agents.wakeup()
  Then the host returns JSON-RPC error -32600
  And the error message contains "capability 'agents.wakeup' not granted"
```

**Feature: Plugin HTTP Routes**
```gherkin
Scenario: HTTP request forwarded to plugin
  Given a plugin "@test/plugin-foo" with route handler for "GET /status"
  When I send GET /api/plugins/@test/plugin-foo/status
  Then the worker receives a "handleRequest" RPC
  And the HTTP response matches the worker's return value
```

### 12.2 TDD Unit Tests

Written before each component's implementation.

| Component | Test File | Key Test Cases |
|-----------|-----------|---------------|
| JSON-RPC framing | `rpc.test.ts` | Parse valid/invalid messages, serialize requests/responses, handle bidirectional concurrent calls, timeout handling |
| Manifest validation | `loader.test.ts` | Valid manifest passes, missing required fields rejected, invalid cron expression rejected, unknown capabilities warned |
| Capability enforcement | `sdk-proxy.test.ts` | Allowed capability passes, denied capability returns error, config.get always allowed, logger always allowed |
| Job scheduler | `job-scheduler.test.ts` | Cron parsing, next_run_at calculation, tick triggers due jobs, skips running jobs, handles worker-down |
| Process manager | `process-manager.test.ts` | Spawn and initialize, health check pass/fail, restart on crash with backoff, graceful shutdown sequence, SIGKILL after timeout |
| Event bus | `event-bus.test.ts` | Subscribe from manifest, deliver to subscribed workers, skip unsubscribed, handle worker-down gracefully |
| SDK proxy handlers | `sdk-proxy.test.ts` | Each handler maps to correct service call, actor identity set correctly, error propagation |
| Plugin SDK (client) | `plugin-sdk.test.ts` | createPluginWorker sets up RPC, ctx methods send correct RPC calls, handler routing works |

---

## 13. Dependencies

### 13.1 New npm Dependencies

| Package | Purpose | Where |
|---------|---------|-------|
| `cron-parser` | Parse cron expressions, calculate next run time | `server/` |
| `zod` | Manifest validation (already in project) | `server/` |

### 13.2 Existing Infrastructure Used

- Express (route mounting)
- Drizzle ORM (DB schema + queries)
- Node.js `child_process.spawn` (worker processes)
- pnpm workspaces (plugin SDK package)

---

## 14. Phase 2 Roadmap (Out of Scope)

For reference, Phase 2 will add:

- UI extension slots (pages, tabs, widgets, sidebar) — plugins contribute React components
- Plugin settings UI — auto-generated forms from `instanceConfigSchema`
- Hot reload — plugin install/uninstall/upgrade without server restart
- Plugin-to-plugin communication — cross-plugin events and service calls
- Marketplace / Company Store — browse and install plugins from a registry
- Webhook declarations — structured webhook endpoints with signature validation
- iframe sandboxing — run plugin UI in sandboxed iframes for untrusted plugins
