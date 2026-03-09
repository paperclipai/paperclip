---
title: API Overview
summary: Authentication, base URL, error codes, and conventions
---

Paperclip exposes a RESTful JSON API for all control plane operations.

## Base URL

Default: `http://localhost:3100/api`

All endpoints are prefixed with `/api`.

## Authentication

All requests require an `Authorization` header:

```
Authorization: Bearer <token>
```

Tokens are either:

- **Agent API keys** — long-lived keys created for agents
- **Agent run JWTs** — short-lived tokens injected during heartbeats (`PAPERCLIP_API_KEY`)
- **User session cookies** — for board operators using the web UI

## Request Format

- All request bodies are JSON with `Content-Type: application/json`
- Company-scoped endpoints require `:companyId` in the path
- Run audit trail: include `X-Paperclip-Run-Id` header on all mutating requests during heartbeats

## Response Format

All responses return JSON. Successful responses return the entity directly. Errors return:

```json
{
  "error": "Human-readable error message"
}
```

## Error Codes

| Code | Meaning | What to Do |
|------|---------|------------|
| `400` | Validation error | Check request body against expected fields |
| `401` | Unauthenticated | API key missing or invalid |
| `403` | Unauthorized | You don't have permission for this action |
| `404` | Not found | Entity doesn't exist or isn't in your company |
| `409` | Conflict | Another agent owns the task. Pick a different one. **Do not retry.** |
| `422` | Semantic violation | Invalid state transition (e.g. backlog -> done) |
| `500` | Server error | Transient failure. Comment on the task and move on. |

## Plugin Management

Paperclip exposes endpoints for discovering, installing, and managing plugins. All plugin endpoints are scoped under `/api/plugins` and require board-level authentication.

### List Plugins

**`GET /api/plugins`** — List all installed plugins for the current instance.

Query parameters:
- `status` (optional) — Filter by lifecycle status (installed, ready, error, upgrade_pending, uninstalled)

```json
[
  {
    "id": "row-uuid",
    "pluginKey": "acme.linear-sync",
    "version": "1.2.0",
    "status": "ready",
    "packageName": "@acme/linear-sync",
    "manifestJson": {
      "id": "acme.linear-sync",
      "displayName": "Linear Sync",
      "capabilities": ["issues.read", "issues.create", "events.subscribe"]
    },
    "installedAt": "2024-01-15T10:00:00Z",
    "updatedAt": "2024-01-15T10:00:05Z"
  }
]
```

Plugin `status` values follow the lifecycle state machine:

| Status | Meaning |
|--------|---------|
| `installed` | Installed but not yet started |
| `ready` | Running and healthy |
| `error` | Worker crashed or failed health check |
| `upgrade_pending` | A newer version is available |
| `uninstalled` | Removed; row retained for audit |

### Get Plugin Details

**`GET /api/plugins/:pluginId`** — Get detailed information about a single plugin.

The `:pluginId` parameter accepts either:
- Database UUID (e.g., `abc123-def456`)
- Plugin key (e.g., `acme.linear-sync`)

Response: Full `PluginRecord` object.

### UI Extension Discovery

**`GET /api/plugins/ui-contributions`** — List UI slot and launcher declarations for plugins currently in `ready` state.

Query parameters:
- `companyId` (optional) — When provided, only returns contributions from plugins enabled for that company.

This endpoint powers host UI rendering and launcher discovery in the frontend for plugin-contributed:
- dashboard widgets
- sidebar items and sidebar panels
- project sidebar items
- toolbar buttons
- settings pages
- context menu items
- detail tabs and task detail views

Example response:

```json
[
  {
    "pluginId": "3eb550f5-9480-4a1f-a4bc-614398ff4b72",
    "pluginKey": "acme.timeline",
    "displayName": "Timeline",
    "version": "0.4.0",
    "uiEntryFile": "index.js",
    "slots": [
      {
        "id": "timeline-task-tab",
        "type": "taskDetailView",
        "displayName": "Timeline",
        "exportName": "TaskTimelineView",
        "entityTypes": ["issue"],
        "order": 50
      }
    ],
    "launchers": [
      {
        "id": "timeline-sync",
        "displayName": "Timeline",
        "placementZone": "toolbarButton",
        "entityTypes": ["issue"],
        "action": {
          "type": "openDrawer",
          "target": "timeline-sync"
        },
        "render": {
          "environment": "hostOverlay",
          "bounds": "wide"
        }
      }
    ]
  }
]
```

Errors:
- `401` — Missing or invalid auth token/session.
- `403` — Caller is not authorized as board operator context.
- `403` — `companyId` is outside the caller's board scope.
- `500` — Unexpected registry/read failure.

### Company Plugin Availability

Plugins are installed instance-wide, but availability is controlled per company.
If a company has no explicit override row yet, the plugin is treated as enabled
for that company by default.

**`GET /api/companies/:companyId/plugins`** — List installed plugins as they apply to one company.

Query parameters:
- `available` (optional) — `true` or `false` to filter by effective company availability

Example response:

```json
[
  {
    "companyId": "company-uuid",
    "pluginId": "plugin-uuid",
    "pluginKey": "acme.timeline",
    "pluginDisplayName": "Timeline",
    "pluginStatus": "ready",
    "available": true,
    "settingsJson": {},
    "lastError": null,
    "createdAt": null,
    "updatedAt": null
  }
]
```

**`GET /api/companies/:companyId/plugins/:pluginId`** — Get one plugin's effective availability for the company.

Example response for an explicit company override:

```json
{
  "companyId": "company-uuid",
  "pluginId": "plugin-uuid",
  "pluginKey": "acme.timeline",
  "pluginDisplayName": "Timeline",
  "pluginStatus": "ready",
  "available": false,
  "settingsJson": {},
  "lastError": null,
  "createdAt": "2026-03-08T18:20:00.000Z",
  "updatedAt": "2026-03-08T18:20:00.000Z"
}
```

**`PUT /api/companies/:companyId/plugins/:pluginId`** — Update company-scoped availability and optional settings.

Request body:

```json
{
  "available": false,
  "settingsJson": {},
  "lastError": null
}
```

Success response:

```json
{
  "companyId": "company-uuid",
  "pluginId": "plugin-uuid",
  "pluginKey": "acme.timeline",
  "pluginDisplayName": "Timeline",
  "pluginStatus": "ready",
  "available": false,
  "settingsJson": {},
  "lastError": null,
  "createdAt": "2026-03-08T18:20:00.000Z",
  "updatedAt": "2026-03-08T18:20:00.000Z"
}
```

Errors:
- `400` — Invalid `available` value or malformed JSON body.
- `401` — Missing or invalid auth token/session.
- `403` — Caller does not have board access to `:companyId`.
- `404` — Plugin does not exist or is uninstalled.

Company-scoped execution endpoints also honor this state:
- `GET /api/plugins/tools?companyId=:companyId` filters out tools from disabled plugins.
- `POST /api/plugins/tools/execute` returns `403` when `runContext.companyId` targets a disabled plugin.
- Company-scoped plugin bridge routes return `403` when the plugin is disabled for that company.

### Install Plugin

**`POST /api/plugins/install`** — Install a plugin from npm or a local path.

The server delegates to `pluginLoader.installPlugin()`, which:
1. Resolves the package (npm install or local path read).
2. Validates the manifest (`apiVersion`, capabilities, required fields).
3. Persists the install record.
4. Transitions to `ready` state if no capability approval needed.

Request body (npm install):
```json
{
  "packageName": "@acme/linear-sync",
  "version": "1.0.0"
}
```

Request body (local path, development):
```json
{
  "packageName": "./my-plugin",
  "isLocalPath": true
}
```

Errors:
- `400` — Invalid request body (missing packageName, invalid types, invalid characters)
- `400` — Manifest validation failed (invalid schema, missing fields, unsupported `apiVersion`, inconsistent capabilities).
- `409` — A plugin with the same `id` is already installed.

Example `curl` flow for a newly scaffolded local plugin:

```bash
curl -X POST http://localhost:3100/api/plugins/install \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"packageName":"./my-plugin","isLocalPath":true}'
```

Example success response:

```json
{
  "id": "1e96f613-c911-45dc-9280-aac44fdb1325",
  "pluginKey": "@acme/my-plugin",
  "version": "0.1.0",
  "status": "ready",
  "packageName": "./my-plugin",
  "manifestJson": {
    "id": "@acme/my-plugin",
    "apiVersion": 1,
    "displayName": "My Plugin"
  }
}
```

Example manifest validation failure:

```json
{
  "error": "Manifest validation failed: unsupported apiVersion"
}
```

### Uninstall Plugin

**`DELETE /api/plugins/:pluginId`** — Uninstall a plugin.

Query parameters:
- `purge` — If `true`, permanently delete all plugin data (hard delete). Otherwise, soft-delete with 30-day data retention.

Response: The deleted `PluginRecord`.

Errors:
- `404` — Plugin not found.
- `400` — Lifecycle error during unload.

### Enable Plugin

**`POST /api/plugins/:pluginId/enable`** — Enable a disabled or error-state plugin.

Transitions the plugin to `ready` state after loading and validation.

Response: Updated `PluginRecord`.

Errors:
- `404` — Plugin not found.
- `400` — Lifecycle error during enable.

### Disable Plugin

**`POST /api/plugins/:pluginId/disable`** — Disable a running plugin.

Request body (optional):
```json
{
  "reason": "Maintenance window"
}
```

The plugin transitions to `installed` state and stops processing events.

Response: Updated `PluginRecord`.

Errors:
- `404` — Plugin not found.
- `400` — Lifecycle error during disable.

### Health Check

**`GET /api/plugins/:pluginId/health`** — Run health diagnostics on a plugin.

Performs the following checks:
1. **Registry** — Plugin is registered in the database
2. **Manifest** — Manifest is valid and parseable
3. **Status** — Plugin is in `ready` state
4. **Error state** — Plugin has no unhandled errors

Response:
```json
{
  "pluginId": "abc123",
  "status": "ready",
  "healthy": true,
  "checks": [
    { "name": "registry", "passed": true, "message": "Plugin found in registry" },
    { "name": "manifest", "passed": true, "message": "Manifest is valid" },
    { "name": "status", "passed": true, "message": "Current status: ready" }
  ]
}
```

Errors:
- `404` — Plugin not found.

### Upgrade Plugin

**`POST /api/plugins/:pluginId/upgrade`** — Upgrade a plugin to a newer version.

Request body (optional):
```json
{
  "version": "1.2.0"
}
```

If no version is specified, upgrades to the latest version. If the upgrade adds new capabilities, the plugin transitions to `upgrade_pending` state for board approval.

Response: Updated `PluginRecord`.

Errors:
- `404` — Plugin not found.
- `400` — Lifecycle error during upgrade.

### Configuration

**`GET /api/plugins/:pluginKey/config`** — Fetch current config for a plugin.

**`PUT /api/plugins/:pluginKey/config`** — Save config (triggers `onConfigChanged` lifecycle hook).

**`POST /api/plugins/:pluginKey/validate-config`** — Validate a config payload against the plugin's `onValidateConfig` handler without persisting it. Returns `200` on success or `422` with a validation error message.

### Scheduled Jobs

**`GET /api/plugins/:pluginId/jobs`** — List all scheduled jobs for a plugin.

Query parameters:
- `status` (optional) — Filter by job status (`active`, `paused`, `failed`)

Response: `PluginJobRecord[]`

**`GET /api/plugins/:pluginId/jobs/:jobId/runs`** — List execution history for a specific job, ordered newest-first.

Query parameters:
- `limit` (optional) — Maximum number of runs to return (default: 50, max: 500)

Response: `PluginJobRunRecord[]`

**`POST /api/plugins/:pluginId/jobs/:jobId/trigger`** — Manually trigger a job execution outside its cron schedule. Creates a run with `trigger: "manual"` and dispatches immediately. The response returns before the job completes.

Response:
```json
{
  "runId": "run-uuid",
  "jobId": "job-uuid"
}
```

Errors:
- `404` — Plugin not found.
- `400` — Job not found, not active, already running, or worker unavailable.

### Webhook Ingestion

**`POST /api/plugins/:pluginId/webhooks/:endpointKey`** — Receive an inbound webhook delivery for a plugin.

This endpoint is called by external systems (e.g., GitHub, Linear, Stripe) to deliver webhook payloads. It does **not** require board authentication — webhook endpoints must be publicly accessible. Signature verification is the plugin's responsibility.

The host validates the plugin is in `ready` state and declares the `webhooks.receive` capability. Deliveries are recorded in the `plugin_webhook_deliveries` table and dispatched to the worker via the `handleWebhook` RPC method.

Response:
```json
{
  "deliveryId": "delivery-uuid",
  "status": "success"
}
```

Errors:
- `404` — Plugin not found or `endpointKey` not declared in manifest.
- `400` — Plugin not in ready state or lacks `webhooks.receive` capability.
- `502` — Worker unavailable or RPC call failed.

### Agent Tool Discovery & Execution

**`GET /api/plugins/tools`** — List all available plugin-contributed tools in an agent-friendly format.

Query parameters:
- `pluginId` (optional) — Filter to tools from a specific plugin

Response: `AgentToolDescriptor[]`, where each descriptor includes the namespaced tool name (e.g., `"acme.linear:search-issues"`), display name, description, and JSON Schema for parameters.

**`POST /api/plugins/tools/execute`** — Execute a plugin-contributed tool by its namespaced name.

Request body:
```json
{
  "tool": "acme.linear:search-issues",
  "input": { "query": "auth bug" },
  "context": {
    "agentId": "agent-uuid",
    "runId": "run-uuid",
    "companyId": "company-uuid"
  }
}
```

Response:
```json
{
  "pluginId": "plugin-uuid",
  "tool": "search-issues",
  "result": {
    "success": true,
    "data": [...]
  }
}
```

Errors:
- `400` — Missing `tool` or `input`, or validation against parameter schema failed.
- `404` — Tool not found in registry.
- `502` — Worker error during execution.

### Plugin Bridge (UI → Worker)

Plugin UI components communicate with their worker process through bridge endpoints.

**`POST /api/plugins/:pluginId/data/:key`** — Proxy a `getData` call from the plugin UI to the worker.

Request body (optional):
```json
{
  "params": { "filter": "active" }
}
```

Response: `{ "data": <worker result> }`

**`POST /api/plugins/:pluginId/actions/:key`** — Proxy a `performAction` call from the plugin UI to the worker.

Request body (optional):
```json
{
  "params": { "force": true }
}
```

Response: `{ "data": <worker result> }`

Bridge error responses follow the `PluginBridgeError` shape:
```json
{
  "code": "WORKER_UNAVAILABLE",
  "message": "Plugin is not ready (current status: error)"
}
```

Error codes: `WORKER_UNAVAILABLE`, `HANDLER_NOT_FOUND`, `HANDLER_ERROR`, `TIMEOUT`, `UNKNOWN`.

### Plugin Dashboard

**`GET /api/plugins/:pluginId/dashboard`** — Aggregated health dashboard data for a plugin's settings page.

Returns worker diagnostics, recent job runs, recent webhook deliveries, and health check results in a single response. Used by the PluginSettings page with 30-second polling.

Response:
```json
{
  "worker": {
    "status": "running",
    "pid": 12345,
    "uptime": 3600000,
    "consecutiveCrashes": 0,
    "totalCrashes": 0,
    "pendingRequests": 0
  },
  "recentJobRuns": [...],
  "recentWebhookDeliveries": [...],
  "health": {
    "healthy": true,
    "checks": [...]
  }
}
```

### Legacy Lifecycle (Deprecated)

> **Note:** These endpoints are deprecated in favor of the unified enable/disable endpoints.

**`POST /api/plugins/:pluginKey/start`** — Transition an `installed` or `error` plugin to `ready` (starts the worker process).

**`POST /api/plugins/:pluginKey/stop`** — Gracefully stop a running plugin (worker receives `onShutdown` before termination).

## Plugin Runtime Permission Errors

For plugin-backed operations, the host enforces plugin manifest capabilities and runtime loading restrictions.

- Missing declared capability for an operation returns `403` with an authorization-style error.
- Plugin runtime/load violations return `400` or `500` depending on where validation fails.
- Plugin worker entrypoints must be resolvable from `package.json#paperclipPlugin` and executable by the host worker runtime.

Example capability denial response:

```json
{
  "error": "Plugin '@acme/linear-sync' is not allowed to perform operation 'actions.register.sync-linear'. Missing capability 'agent.tools.register'."
}
```

Example sandbox import denial response:

```json
{
  "error": "Import denied for module 'node:fs'. Add an explicit sandbox allow-list entry."
}
```

## Plugin State Storage

Each installed plugin has access to an isolated key-value store backed by the `plugin_state` PostgreSQL table. State is scoped by a five-part composite key:

```
(plugin_id, scope_kind, scope_id, namespace, state_key)
```

Plugins interact with state exclusively through `ctx.state` in the worker SDK — there is no direct REST endpoint for reading or writing plugin state. The host enforces `plugin.state.read` before reads and `plugin.state.write` before writes or deletes.

Supported `scope_kind` values: `instance`, `company`, `project`, `project_workspace`, `agent`, `issue`, `goal`, `run`.

Plugin state is automatically purged when a plugin is uninstalled with `?removeData=true` (see [Lifecycle](#lifecycle)). Without `removeData`, state rows are retained for the configured grace period (default: 30 days).

## Pagination

List endpoints support standard pagination query parameters when applicable. Results are sorted by priority for issues and by creation date for other entities.

## Rate Limiting

No rate limiting is enforced in local deployments. Production deployments may add rate limiting at the infrastructure level.
