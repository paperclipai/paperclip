# Paperclip Operational Audit 2026 — Sprint 4
## 09 PLUGIN ARCHITECTURE

**Evidence date:** 2026-07-15  
**Scope:** Plugin discovery, installation, loading, lifecycle, worker model, capabilities, host services, and audit integration.

---

## 1. How Plugins Are Discovered

Paperclip discovers plugins from two sources:

| Source | Path / Mechanism | Pattern |
|--------|------------------|---------|
| Local filesystem | `~/.paperclip/plugins/` | Scan subdirectories for packages with `paperclipPlugin` key in `package.json` or matching naming convention |
| npm / node_modules | `process.cwd()/node_modules` + `~/.paperclip/plugins/node_modules` | Packages matching `paperclip-plugin-*` or scoped `@*/plugin-*` |
| Registry | Reserved field `registryUrl` in `PluginLoaderOptions` | **Not implemented** (logs warning) |

**Key symbols:**
- `plugin-loader.ts::discoverAll()` — orchestrates both sources with path deduplication.
- `plugin-loader.ts::discoverFromLocalFilesystem()` — scans `~/.paperclip/plugins/`.
- `plugin-loader.ts::discoverFromNpm()` — scans `node_modules` for naming-convention matches.
- `plugin-loader.ts::isPluginPackageName()` — accepts `paperclip-plugin-*` and scoped `@scope/plugin-*`.

**Confidence: HIGH** — Full implementation present; registry source is a reserved no-op.

---

## 2. Where Plugin Metadata Is Stored

Plugin metadata is stored in three layers:

### 2.1 Instance-wide plugin registry (`plugins` table)
- **File:** `packages/db/src/schema/plugins.ts`
- **Table:** `plugins`
- Columns: `id`, `plugin_key` (unique, derived from manifest `id`), `package_name`, `version`, `api_version`, `categories`, `manifest_json` (full manifest snapshot as JSONB), `status`, `install_order`, `package_path`, `last_error`, `installed_at`, `updated_at`

### 2.2 Instance configuration (`plugin_config` table)
- **File:** `packages/db/src/schema/plugin_config.ts`
- **Table:** `plugin_config`
- One row per plugin; `config_json` holds operator-provided values validated against `instanceConfigSchema` from the manifest.

### 2.3 Company-scoped enablement (`plugin_company_settings` table)
- **File:** `packages/db/src/schema/plugin_company_settings.ts`
- **Table:** `plugin_company_settings`
- Unique on `(company_id, plugin_id)`. `enabled` boolean (default `true`). Absence of a row means "enabled by default."

**Confidence: HIGH**

---

## 3. How Plugins Are Enabled or Disabled

Plugins have a lifecycle state machine managed by `PluginLifecycleManager`.

### 3.1 Lifecycle states
| State | Meaning |
|-------|---------|
| `installed` | Just persisted in DB; not yet activated |
| `ready` | Worker running; all subsystems registered |
| `disabled` | Operator paused; worker stopped |
| `error` | Worker crash or health failure; auto-restart exhausted |
| `upgrade_pending` | Upgrade added new capabilities; awaiting operator approval |
| `uninstalled` | Soft delete; hard delete with `removeData=true` |

### 3.2 Valid transitions
- `installed` → `ready` | `error` | `uninstalled`
- `ready` → `disabled` | `error` | `upgrade_pending` | `uninstalled`
- `disabled` → `ready` | `uninstalled`
- `error` → `ready` | `uninstalled`
- `upgrade_pending` → `ready` | `error` | `uninstalled`
- `uninstalled` → `installed` (reinstall)

**Key symbols:**
- `plugin-lifecycle.ts::VALID_TRANSITIONS` — state machine definition
- `plugin-lifecycle.ts::transition()` — persistence + event emission
- `plugin-lifecycle.ts::load()` / `enable()` / `disable()` / `unload()` / `markError()` / `markUpgradePending()` / `upgrade()`

**Confidence: HIGH** — Fully implemented with event emission (`plugin.loaded`, `plugin.enabled`, `plugin.disabled`, `plugin.unloaded`, `plugin.status_changed`, `plugin.error`, `plugin.upgrade_pending`, `plugin.worker_started`, `plugin.worker_stopped`).

---

## 4. How Workers Are Launched

Each activated plugin gets **one dedicated worker process**.

### 4.1 Spawn mechanics
- **File:** `server/src/services/plugin-worker-manager.ts`
- `createPluginWorkerHandle()` forks a child process via Node.js `child_process.fork()`.
- Entrypoint: manifest `entrypoints.worker` path (CJS bundle expected).
- stdio: `["pipe", "pipe", "pipe", "ipc"]` — NDJSON over stdout/stdin; stderr captured.

### 4.2 Environment inheritance (minimal)
The worker receives a **controlled, minimal environment** — `process.env` is NOT spread. Only these are passed:
- `PATH`, `NODE_PATH`
- `PAPERCLIP_PLUGIN_ID`
- `NODE_ENV`
- `TZ`
- Plus any explicit `env` from `WorkerStartOptions`

### 4.3 Initialization protocol
1. Host forks process.
2. Host sends `initialize` JSON-RPC request with `{ manifest, config, instanceInfo, apiVersion, databaseNamespace }`.
3. Worker responds with `{ ok: true, supportedMethods?: string[] }`.
4. On success, status becomes `running`; on failure, `crashed`.

### 4.4 Crash recovery
- Exponential backoff: `MIN_BACKOFF_MS * 2^(consecutiveCrashes - 1)` with ±25% jitter.
- Max backoff: 5 minutes.
- Max consecutive crashes: 10 within a 10-minute window. After that, auto-restart stops.
- Graceful shutdown: `shutdown` RPC → 10s drain → SIGTERM → 5s → SIGKILL.

**Key symbols:**
- `plugin-worker-manager.ts::createPluginWorkerHandle()`
- `plugin-worker-manager.ts::createPluginWorkerManager()`
- `plugin-worker-manager.ts::spawnProcess()`
- `plugin-worker-manager.ts::handleProcessExit()` — crash recovery logic

**Confidence: HIGH**

---

## 5. Workers Are Isolated Processes

**Yes — one process per plugin.** Workers run as separate Node.js child processes. They communicate with the host via JSON-RPC over stdio (NDJSON). No shared memory. Failure isolation is explicit: a plugin crash does not affect the host or other plugins.

**Confidence: HIGH**

---

## 6. What Capabilities Plugins May Request

Capabilities are declared in the manifest `capabilities` array. The host enforces them at runtime via `OPERATION_CAPABILITIES` mapping.

### 6.1 Data read capabilities
- `companies.read`, `projects.read`, `project.workspaces.read`, `issues.read`, `issue.relations.read`, `issue.comments.read`, `agents.read`, `goals.read`, `activity.read`, `costs.read`, `issues.orchestration.read`

### 6.2 Data write capabilities
- `issues.create`, `issues.update`, `issue.relations.write`, `issues.checkout`, `issue.subtree.read`, `issues.wakeup`, `issue.comments.create`, `issue.interactions.create`, `activity.log.write`, `metrics.write`, `telemetry.track`

### 6.3 Runtime / integration capabilities
- `events.subscribe`, `events.emit`, `jobs.schedule`, `webhooks.receive`, `http.outbound`, `secrets.read-ref`

### 6.4 Agent tool capabilities
- `agent.tools.register` (declare tools), `agent.tools.register` (execute tools — same cap)

### 6.5 Database capabilities
- `database.namespace.read`, `database.namespace.migrate`, `database.namespace.write`

### 6.6 UI capabilities
- `ui.sidebar.register`, `ui.page.register`, `ui.detailTab.register`, `ui.dashboardWidget.register`, `ui.action.register`, `ui.commentAnnotation.register`, `instance.settings.register`

### 6.7 Environment driver capabilities
- `environment.drivers.register`

**Key symbols:**
- `plugin-capability-validator.ts::OPERATION_CAPABILITIES` — runtime enforcement map
- `plugin-capability-validator.ts::UI_SLOT_CAPABILITIES` — UI slot to capability mapping
- `plugin-capability-validator.ts::FEATURE_CAPABILITIES` — manifest feature to capability mapping

**Confidence: HIGH**

---

## 7. How Host Capabilities Are Granted or Denied

### 7.1 Install-time validation
`validateManifestCapabilities()` ensures every declared feature (tools, jobs, webhooks, UI slots, launchers, database, environmentDrivers) has the matching capability in the manifest. Missing capabilities are returned as a list; installation is rejected.

### 7.2 Runtime enforcement
Every worker→host RPC call is gated by `assertOperation(manifest, operation)`, which looks up `OPERATION_CAPABILITIES[operation]` and throws HTTP 403 if any required capability is missing.

- Unknown operations are **rejected by default** (not allowed).
- The capability check happens in the bridge layer before the host handler is invoked.

**Key symbols:**
- `plugin-capability-validator.ts::validateManifestCapabilities()`
- `plugin-capability-validator.ts::checkOperation()` / `assertOperation()`

**Confidence: HIGH**

---

## 8. What Persistence Plugins May Use

### 8.1 Scoped key-value state (`plugin_state` table)
- Scope kinds: `instance`, `company`, `project`, `project_workspace`, `agent`, `issue`, `goal`, `run`
- Namespace + key within scope.
- Unique on `(plugin_id, scope_kind, scope_id, namespace, state_key)` with `nullsNotDistinct` for PostgreSQL 15+.

### 8.2 Structured entity mappings (`plugin_entities` table)
- For external system ID mappings (e.g., Linear issue ↔ Paperclip issue).
- Columns: `entity_type`, `scope_kind`, `scope_id`, `external_id`, `title`, `status`, `data`.

### 8.3 Plugin-owned database namespace
- A plugin can declare `database` in its manifest with `migrationsDir`.
- The host creates a deterministic namespace (schema) and runs migrations.
- Runtime access gated by `database.namespace.*` capabilities.
- Selected core tables may be read-only join targets via `coreReadTables` declaration.

### 8.4 Plugin logs (`plugin_logs` table)
- Buffered batch inserts (flush at 100 entries or every 5 seconds).
- Retention cleanup service exists (`plugin-log-retention.ts`).

**Key symbols:**
- `packages/db/src/schema/plugin_state.ts`
- `packages/db/src/schema/plugin_entities.ts`
- `packages/db/src/schema/plugin_database.ts`
- `packages/db/src/schema/plugin_logs.ts`
- `server/src/services/plugin-state-store.ts`
- `server/src/services/plugin-database.ts`

**Confidence: HIGH**

---

## 9. What Secrets Plugins May Access

Plugins access secrets via `ctx.secrets.resolve(secretRef)`, where `secretRef` is a UUID of a `company_secrets` row.

### 9.1 Security invariants
- Resolved values are **never logged, persisted, or included in error messages**.
- Capability `secrets.read-ref` required.
- Rate limit: 30 resolution attempts per plugin per minute.
- **Scope check:** Only secret UUIDs that appear in the plugin's `configJson` (either at schema-annotated `format: "secret-ref"` paths or by UUID-shape fallback) are allowed. Any other secret UUID returns "not found" to avoid leakage.

### 9.2 Resolution path
1. Validate UUID format.
2. Check against allowed refs extracted from plugin config (30s cache TTL).
3. Look up `company_secrets` row.
4. Fetch latest `company_secret_versions` material.
5. Delegate to `SecretProviderModule` for decryption.

**Key symbols:**
- `server/src/services/plugin-secrets-handler.ts::createPluginSecretsHandler()`
- `server/src/services/plugin-secrets-handler.ts::extractSecretRefsFromConfig()`

**Confidence: HIGH**

---

## 10. How Jobs Are Scheduled

Plugin jobs are declared in the manifest `jobs` array with `jobKey`, `displayName`, and `schedule` (cron expression).

### 10.1 Scheduler mechanics
- Tick interval: every 30 seconds (`DEFAULT_TICK_INTERVAL_MS`).
- Queries `plugin_jobs` for `status = 'active'` and `nextRunAt <= now`.
- Overlap prevention: skips if a `running` `plugin_job_runs` row exists for that job.
- Concurrency limit: max 10 concurrent jobs across all plugins.
- Each run creates a `plugin_job_runs` row: `queued` → `running` → `succeeded` | `failed` | `cancelled`.

### 10.2 Manual trigger
- `triggerJob(jobId)` creates a run with `trigger: "manual"` and dispatches immediately.

### 10.3 Schedule pointer advancement
After each run, `nextRunAt` is recomputed using the cron parser. Even failed runs advance the pointer.

**Key symbols:**
- `server/src/services/plugin-job-scheduler.ts::createPluginJobScheduler()`
- `server/src/services/plugin-job-scheduler.ts::tick()`
- `server/src/services/plugin-job-scheduler.ts::dispatchJob()`
- `server/src/services/cron.ts::parseCron()` / `nextCronTick()`

**Confidence: HIGH**

---

## 11. How Failures Are Surfaced

| Failure type | Surface |
|-------------|---------|
| Worker crash | Exponential backoff restart; `plugins.status` → `error`; `plugins.last_error` updated |
| Job failure | `plugin_job_runs.status` → `failed`; `error` column populated; duration captured |
| Capability denial | RPC returns `CAPABILITY_DENIED` (502 bridge error) |
| Config validation | `plugin_config.last_error` updated; health dashboard shows status |
| Webhook failure | `plugin_webhook_deliveries.status` → `failed`; `error` captured |
| Health check | `onHealth()` RPC polled; degraded/error surfaced in plugin dashboard |

### 11.1 Logging
- Plugin stderr captured per worker and forwarded to host logger.
- Plugin logs (via `ctx.logger`) batched into `plugin_logs` table.
- Structured with `pluginLogLevel`, `pluginTimestamp`, and metadata.

**Key symbols:**
- `plugin-worker-manager.ts::handleProcessExit()` — crash recovery
- `plugin-job-scheduler.ts::dispatchJob()` — job failure recording
- `plugin-host-services.ts::flushPluginLogBuffer()` — batched log persistence

**Confidence: HIGH**

---

## 12. How Plugin Actions Enter the Audit Trail

Plugin mutations that touch Paperclip-owned state are logged via `logActivity()` with:
- `actorType: "plugin"`
- `actorId: pluginId`
- `details` include `sourcePluginId`, `sourcePluginKey`, and initiating actor info (if proxied).

Specifically:
- `issues.create` → logs `issue.created`
- `issues.update` → logs `issue.updated`
- Issue relations mutations → logs `issue.relations.updated`
- `issues.requestWakeup` → logs `issue.assignment_wakeup_requested`
- `issues.assertCheckoutOwner` → logs `issue.checkout_lock_adopted` when adoption occurs

Plugin-initiated `activity.log` capability also allows explicit logging.

**Key symbols:**
- `plugin-host-services.ts::logPluginActivity()` — helper that calls `logActivity()`
- `server/src/services/activity-log.ts::logActivity()`

**Confidence: HIGH**

---

## 13. What UI Contributions Plugins Can Make

Plugins declare UI contributions in `manifest.ui.slots` and `manifest.ui.launchers` (or legacy top-level `launchers`).

### 13.1 Supported slot types
| Slot type | Capability required | Rendering location |
|-----------|---------------------|-------------------|
| `sidebar` | `ui.sidebar.register` | Left sidebar |
| `sidebarPanel` | `ui.sidebar.register` | Sidebar panel |
| `projectSidebarItem` | `ui.sidebar.register` | Project sidebar |
| `page` | `ui.page.register` | Full page at `/:companyPrefix/{routePath}` |
| `detailTab` | `ui.detailTab.register` | Entity detail tabs |
| `taskDetailView` | `ui.detailTab.register` | Task detail view |
| `dashboardWidget` | `ui.dashboardWidget.register` | Dashboard widget grid |
| `globalToolbarButton` | `ui.action.register` | Global toolbar |
| `toolbarButton` | `ui.action.register` | Context toolbar |
| `contextMenuItem` | `ui.action.register` | Context menu |
| `commentAnnotation` | `ui.commentAnnotation.register` | Comment annotations |
| `commentContextMenuItem` | `ui.action.register` | Comment context menu |
| `settingsPage` | `instance.settings.register` | Instance settings page |

### 13.2 Launchers
Declarative launcher metadata with `placementZone`, `action` (type + target), and optional `render` hints (environment, bounds).

### 13.3 Bridge
- `getData` / `performAction` RPC from UI → worker via `POST /api/plugins/:pluginId/bridge/data` and `.../action`.
- REST-friendly aliases: `POST /api/plugins/:pluginId/data/:key` and `.../actions/:key`.
- SSE streaming: `GET /api/plugins/:pluginId/bridge/stream/:channel?companyId=...`

**Confidence: HIGH** — Full implementation present.

---

## 14. Architectural Contradictions

### 14.1 Capability enforcement gap for UI slot rendering
The capability validator checks `checkUiSlot()` at install time, but the actual UI contribution endpoint (`GET /api/plugins/ui-contributions`) filters by `status = 'ready'` without re-validating that every slot in the manifest still has its matching capability. If a plugin's capability set were mutated outside the manifest (not possible through normal flows, but a DB-level edit could do it), the UI would still serve the slot.

**Severity:** Low (requires DB tampering; no exposed mutation path).

### 14.2 Company-scoped enablement is stored but not enforced at worker startup
The `plugin_company_settings` table tracks per-company `enabled` flags, but the plugin loader's `activateReadyPlugin()` and the lifecycle manager's `load()` / `enable()` do not check this table before starting a worker. A plugin is either globally `ready` or not. There is no per-company worker isolation.

**Evidence:**
- `plugin-lifecycle.ts::load()` — no company settings query
- `plugin-loader.ts::loadSingle()` — no company settings query
- `plugin-host-services.ts::ensurePluginAvailableForCompany()` — is a no-op comment: "Plugins are instance-wide in the current runtime."

**Severity:** Medium — company-scoped UI contributions still get the company ID from the UI context, but the worker process itself is global.

### 14.3 `ROUTINE_CATCH_UP_POLICIES` includes `enqueue_missed_with_cap` but routine scheduler does not implement true catch-up for missed windows while routine was paused
The `tickScheduledTriggers` logic in `routines.ts` implements catch-up by iterating from `trigger.nextRunAt` to `now` up to `MAX_CATCH_UP_RUNS` (25). However, this only applies when the scheduler ticks and finds a due trigger. If the routine itself was `paused` and then reactivated, the `nextRunAt` is already stale. The scheduler will fire multiple dispatches, but there is no queue/defer mechanism — dispatches happen in a `for` loop synchronously within the tick. This can create a burst of issue creation.

**Severity:** Low — documented behavior; `coalesce_if_active` mitigates burst for most policies.

### 14.4 Plugin HTTP fetch SSRF protection validates IPs at resolve-time but does not pin TLS certificates
The `validateAndResolveFetchUrl()` resolves DNS, picks the first safe IP, and connects directly to it while preserving the original hostname for SNI. This correctly prevents DNS rebinding to private IPs, but it does not verify that the TLS certificate matches the resolved IP (which would fail by default) or enforce certificate pinning. The implementation relies on Node.js default TLS verification, which checks against the hostname, not the IP.

**Severity:** Low — standard TLS hostname verification still applies; the primary SSRF vector is blocked.

### 14.5 `api.routes.register` capability is checked for route registration but plugin API routes do not appear in any OpenAPI or typed schema generation
Plugin-declared `apiRoutes` are mounted dynamically at `/api/plugins/:pluginId/api/*`. They are not included in the server's typed route index (`server/src/routes/index.ts`). This means:
- No automatic OpenAPI generation for plugin routes.
- No centralized middleware stack validation.
- Route collision with core routes is unlikely (prefix isolation) but not formally prevented.

**Severity:** Low — by design; plugin routes are scoped.

---

*No other contradictions identified from current evidence.*
