---
"@paperclipai/plugin-sdk": minor
"@paperclipai/db": minor
"paperclipai": minor
---

Add plugin runtime infrastructure: out-of-process worker management, JSON-RPC protocol, job scheduling, webhook ingestion, agent tool dispatch, and UI bridge.

**Worker Process Manager** (`plugin-worker-manager.ts`):
- Out-of-process plugin workers via `child_process.fork()` with JSON-RPC 2.0 over NDJSON stdio.
- Crash recovery with exponential backoff (1s–5min), max 10 consecutive crashes.
- Graceful shutdown: shutdown RPC → 10s drain → SIGTERM → 5s grace → SIGKILL.
- Per-worker diagnostics: PID, uptime, crash count, pending requests.

**JSON-RPC Protocol** (`packages/plugins/sdk/src/protocol.ts`):
- Full JSON-RPC 2.0 type system with typed method maps for host→worker (11 methods) and worker→host (30+ methods).
- Factory helpers: `createRequest()`, `createSuccessResponse()`, `createErrorResponse()`, `createNotification()`.
- Type guards: `isJsonRpcRequest()`, `isJsonRpcNotification()`, `isJsonRpcResponse()`.
- ID overflow protection at `Number.MAX_SAFE_INTEGER`.

**Worker-Side RPC Host** (`packages/plugins/sdk/src/worker-rpc-host.ts`):
- Runs inside child process, reads JSON-RPC from stdin, dispatches to plugin handlers.
- Full `PluginContext` implementation with all `ctx.*` clients wired via RPC.
- Event handler error boundary prevents one failing handler from crashing the worker.

**Host-Side Client Factory** (`packages/plugins/sdk/src/host-client-factory.ts`):
- `createHostClientHandlers()` factory for capability-gated proxy handlers.
- `METHOD_CAPABILITY_MAP` maps every worker→host method to required capabilities.

**Job Scheduler** (`plugin-job-scheduler.ts`, `cron.ts`, `plugin-job-store.ts`, `plugin-job-coordinator.ts`):
- Tick-based scheduler (30s default) with overlap prevention and concurrency limits.
- Lightweight 5-field cron parser supporting `*`, ranges, steps, and lists.
- Job run lifecycle: `queued` → `running` → `succeeded` | `failed` with duration tracking.
- Job coordinator bridges lifecycle events to scheduler registration.

**Webhook Ingestion** (`server/src/routes/plugins.ts`):
- `POST /api/plugins/:pluginId/webhooks/:endpointKey` — public endpoint for external webhook delivery.
- Delivery recording in `plugin_webhook_deliveries` table with status tracking.

**Agent Tool System** (`plugin-tool-registry.ts`, `plugin-tool-dispatcher.ts`):
- In-memory dual-index registry with namespaced tool identifiers (`pluginId:toolName`).
- Lifecycle integration: auto-register/unregister tools when plugins enable/disable.
- Agent-friendly tool discovery and execution routing.

**Plugin UI Bridge** (`ui/src/plugins/bridge.ts`, `bridge-init.ts`, `slots.tsx`):
- `usePluginData(key)` and `usePluginAction(key)` React hooks for UI↔worker communication.
- Dynamic ESM import loader with error boundary isolation per plugin.
- Global bridge registry on `globalThis.__paperclipPluginBridge__` for module federation.

**Plugin Settings & Dashboard** (`PluginSettings.tsx`, `JsonSchemaForm.tsx`):
- Auto-generated config forms from JSON Schema (`instanceConfigSchema`).
- Runtime health dashboard: worker status, job runs, webhook deliveries (30s polling).

**REST API Routes** (`server/src/routes/plugins.ts`):
- Job listing, triggering, and run history endpoints.
- Bridge proxy endpoints for `getData` and `performAction`.
- Tool discovery and execution endpoints.
- Dashboard aggregation endpoint.
- Config CRUD with validation and test endpoints.

**Static UI Serving** (`server/src/routes/plugin-ui-static.ts`):
- `GET /_plugins/:pluginId/ui/*` with path traversal prevention.
- Content-hash based immutable caching, ETag-based revalidation for non-hashed files.

- 1879 tests across 83 files, all passing.
