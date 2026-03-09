# Paperclip Plugin System Specification

Status: **partially implemented** on the `feature/plugins` branch

This document is the complete specification for Paperclip's plugin and extension architecture.
It expands the brief plugin notes in [doc/SPEC.md](../SPEC.md) and should be read alongside the comparative analysis in [doc/plugins/ideas-from-opencode.md](./ideas-from-opencode.md).

### Implementation Status

The following spec sections are implemented on `feature/plugins`:

| Section | Status | Implementation |
|---------|--------|----------------|
| §8 Plugin Discovery | Done | `server/src/services/plugin-loader.ts` |
| §10 Package Contract | Done | `packages/shared/src/validators/plugin.ts` |
| §10.1 Manifest Shape | Done | `packages/shared/src/types/plugin.ts` |
| §11 Agent Tools | Done | `server/src/services/plugin-tool-registry.ts`, `plugin-tool-dispatcher.ts` |
| §12 Process Model | Done | `server/src/services/plugin-worker-manager.ts` (out-of-process, `child_process.fork`) |
| §12.4 Failure Policy | Done | Exponential backoff, max 10 consecutive crashes |
| §12.5 Graceful Shutdown | Done | Shutdown RPC → SIGTERM → SIGKILL with configurable timeouts |
| §13 Host-Worker Protocol | Done | `packages/plugins/sdk/src/protocol.ts` (JSON-RPC 2.0 over NDJSON stdio) |
| §14 SDK Surface | Done | `packages/plugins/sdk/src/worker-rpc-host.ts`, `host-client-factory.ts` |
| §15 Capability Model | Done | `server/src/services/plugin-capability-validator.ts`, `host-client-factory.ts` |
| §16 Event System | Done | `server/src/services/plugin-event-bus.ts` |
| §17 Scheduled Jobs | Done | `server/src/services/plugin-job-scheduler.ts`, `cron.ts`, `plugin-job-store.ts` |
| §18 Webhooks | Done | `server/src/routes/plugins.ts` (webhook ingestion route) |
| §19 UI Extension Model | Done | `ui/src/plugins/slots.tsx`, `bridge.ts`, `bridge-init.ts` |
| §19.8 Plugin Settings UI | Done | `ui/src/components/JsonSchemaForm.tsx`, `ui/src/pages/PluginSettings.tsx` |
| §21 Persistence | Done | `packages/db/src/schema/plugins.ts` and related tables |
| §22 Secrets | Done | `server/src/services/plugin-secrets-handler.ts` |
| §24 Operator UX | Done | `ui/src/pages/PluginManager.tsx`, `PluginSettings.tsx` |

Not yet implemented:
- §20 Local Tooling (workspace plugins) — deferred
- §25.4.5 Frontend Cache Invalidation — cache headers implemented, but no WebSocket push for live invalidation
- §26 Plugin Observability — structured logging implemented, but no dedicated metrics/tracing export
- §29 Compatibility / Versioning — single API version (v1) supported; migration tooling deferred

## 1. Scope

This spec covers:

- plugin packaging and installation
- runtime model
- trust model
- capability system
- UI extension surfaces
- plugin settings UI
- agent tool contributions
- event, job, and webhook surfaces
- plugin-to-plugin communication
- local tooling approach for workspace plugins
- Postgres persistence for extensions
- uninstall and data lifecycle
- plugin observability
- plugin development and testing
- operator workflows
- hot plugin lifecycle (no server restart)
- SDK versioning and compatibility rules

This spec does not cover:

- a public marketplace
- cloud/SaaS multi-tenancy
- arbitrary third-party schema migrations in the first plugin version
- iframe-sandboxed plugin UI in the first plugin version (plugins render as ES modules in host extension slots)

## 2. Core Assumptions

Paperclip plugin design is based on the following assumptions:

1. Paperclip is single-tenant and self-hosted.
2. Plugin installation is global to the instance, but plugin availability and company-specific settings are scoped per company.
3. "Companies" remain core Paperclip business objects. They are not plugin code-execution trust boundaries, but they are enablement and configuration boundaries for company-context plugin surfaces.
4. Board governance, approval gates, budget hard-stops, and core task invariants remain owned by Paperclip core.
5. Projects already have a real workspace model via `project_workspaces`, and local/runtime plugins should build on that instead of inventing a separate workspace abstraction.

## 3. Goals

The plugin system must:

1. Let operators install global instance-wide plugins.
2. Let operators enable or disable an installed plugin independently for each company.
3. Let plugins add major capabilities without editing Paperclip core.
4. Keep core governance and auditing intact.
5. Support both local/runtime plugins and external SaaS connectors.
6. Support future plugin categories such as:
   - new agent adapters
   - revenue tracking
   - knowledge base
   - issue tracker sync
   - metrics/dashboards
   - file/project tooling
7. Use simple, explicit, typed contracts.
8. Keep failures isolated so one plugin does not crash the entire instance.

## 4. Non-Goals

The first plugin system must not:

1. Allow arbitrary plugins to override core routes or core invariants.
2. Allow arbitrary plugins to mutate approval, auth, issue checkout, or budget enforcement logic.
3. Allow arbitrary third-party plugins to run free-form DB migrations.
4. Depend on project-local plugin folders such as `.paperclip/plugins`.
5. Depend on automatic install-and-execute behavior at server startup from arbitrary config files.

## 5. Terminology

### 5.1 Instance

The single Paperclip deployment an operator installs and controls.

### 5.2 Company

A first-class Paperclip business object inside the instance.

### 5.3 Project Workspace

A workspace attached to a project through `project_workspaces`.
Plugins resolve workspace paths from this model to locate local directories for file, terminal, git, and process operations.

### 5.4 Platform Module

A trusted in-process extension loaded directly by Paperclip core.

Examples:

- agent adapters
- storage providers
- secret providers
- run-log backends

### 5.5 Plugin

An installable instance-wide extension package loaded through the Paperclip plugin runtime.

Examples:

- Linear sync
- GitHub Issues sync
- Grafana widgets
- Stripe revenue sync
- file browser
- terminal
- git workflow

### 5.6 Plugin Worker

The runtime process used for a plugin.
In this spec, third-party plugins run out-of-process by default.

### 5.7 Capability

A named permission the host grants to a plugin.
Plugins may only call host APIs that are covered by granted capabilities.

## 6. Extension Classes

Paperclip has two extension classes.

## 6.1 Platform Modules

Platform modules are:

- trusted
- in-process
- host-integrated
- low-level

They use explicit registries, not the general plugin worker protocol.

Platform module surfaces:

- `registerAgentAdapter()`
- `registerStorageProvider()`
- `registerSecretProvider()`
- `registerRunLogStore()`

Platform modules are the right place for:

- new agent adapter packages
- new storage backends
- new secret backends
- other host-internal systems that need direct process or DB integration

## 6.2 Plugins

Plugins are:

- globally installed per instance
- loaded through the plugin runtime
- additive
- capability-gated
- isolated from core via a stable SDK and host protocol

Plugin categories:

- `connector`
- `workspace`
- `automation`
- `ui`

A plugin may declare more than one category.

## 7. Project Workspaces

Paperclip already has a concrete workspace model:

- projects expose `workspaces`
- projects expose `primaryWorkspace`
- the database contains `project_workspaces`
- project routes already manage workspaces

Plugins that need local tooling (file browsing, git, terminals, process tracking) can resolve workspace paths through the project workspace APIs and then operate on the filesystem, spawn processes, and run git commands directly. The host does not wrap these operations — plugins own their own implementations.

## 8. Installation Model

Plugin installation is global and operator-driven.

There is no per-company install table.

However, availability is company-scoped:

- a plugin is installed once per instance
- each company independently enables or disables that installed plugin
- company-specific plugin settings are stored separately from instance-wide plugin config
- company-context UI, tools, and actions must respect company availability

The host models company availability with default-on behavior plus explicit overrides:

- if no `plugin_company_settings` row exists for `(company_id, plugin_id)`, the plugin is available to that company by default
- if a row exists with `enabled = true`, the plugin remains available and the row stores company-specific settings
- if a row exists with `enabled = false`, the plugin is disabled for that company without uninstalling it globally

If a plugin needs business-object-specific mappings, those are stored as plugin configuration or plugin state.

Examples:

- one global Linear plugin install
- company A enables it with mapping to Linear team X
- company B enables it with mapping to Linear team Y
- company C leaves it disabled and sees no Linear plugin UI or tools
- one global git plugin install
- per-project workspace state stored under `project_workspace`

## 8.1 On-Disk Layout

Plugins live under the Paperclip instance directory.

Suggested layout:

- `~/.paperclip/instances/default/plugins/package.json`
- `~/.paperclip/instances/default/plugins/node_modules/`
- `~/.paperclip/instances/default/plugins/.cache/`
- `~/.paperclip/instances/default/data/plugins/<plugin-id>/`

The package install directory and the plugin data directory are separate.

## 8.2 Operator Commands

Paperclip should add CLI commands:

- `pnpm paperclipai plugin list`
- `pnpm paperclipai plugin install <package[@version]>`
- `pnpm paperclipai plugin uninstall <plugin-id>`
- `pnpm paperclipai plugin upgrade <plugin-id> [version]`
- `pnpm paperclipai plugin doctor <plugin-id>`

These commands are instance-level operations.

## 8.3 Install Process

The install process is:

1. Resolve npm package and version.
2. Install into the instance plugin directory.
3. Read and validate plugin manifest.
4. Reject incompatible plugin API versions.
5. Display requested capabilities to the operator.
6. Persist install record in Postgres.
7. Start plugin worker and run health/validation.
8. Mark plugin `ready` or `error`.

## 9. Load Order And Precedence

Load order must be deterministic.

1. core platform modules
2. built-in first-party plugins
3. installed plugins sorted by:
   - explicit operator-configured order if present
   - otherwise manifest `id`

Rules:

- plugin contributions are additive by default
- plugins may not override core routes or core actions by name collision
- UI slot IDs are automatically namespaced by plugin ID (e.g. `@paperclip/plugin-linear:sync-health-widget`), so cross-plugin collisions are structurally impossible
- if a single plugin declares duplicate slot IDs within its own manifest, the host must reject at install time

## 10. Package Contract

Each plugin package must export a manifest, a worker entrypoint, and optionally a UI bundle.

Suggested package layout:

- `dist/manifest.js`
- `dist/worker.js`
- `dist/ui/` (optional, contains the plugin's frontend bundle)

Suggested `package.json` keys:

```json
{
  "name": "@acme/plugin-linear",
  "version": "0.1.0",
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js",
    "ui": "./dist/ui/"
  }
}
```

### 10.0.1 Launcher Entry Points

Paperclip uses two package-level entry points today:

- `paperclipPlugin.manifest` is the install/discovery entry point. The loader imports this file first so it can validate the manifest before the plugin is persisted or started.
- `paperclipPlugin.worker` is the runtime launcher entry point. The host starts one worker process per installed plugin and executes this file inside the plugin worker runtime. The worker file must call `runWorker(plugin, import.meta.url)` so that when run as the process entrypoint it starts the JSON-RPC host and keeps the process alive; see §14.1 and the SDK docs.

`paperclipPlugin.ui` and `manifest.entrypoints.ui` are UI bundle roots, not executable launchers. The current host serves `entrypoints.ui/index.js` as the plugin UI entry module and resolves named exports from that module using `ui.slots[].exportName`.

Practical implications:

- A plugin has exactly one worker launcher.
- A plugin may have zero or one UI bundle root.
- Multiple UI surfaces (tabs, sidebar items, settings pages, toolbar buttons) are multiplexed through the same UI bundle root rather than separate launcher files.
- Operators reach plugin UI through host-owned routes and controls, not plugin-owned frontend routers.

Launcher discovery is normalized through `GET /api/plugins/ui-contributions`. The
response contains:

- `slots` from `manifest.ui.slots`
- `launchers` from both `manifest.ui.launchers` and the legacy top-level `manifest.launchers`
- a company-filtered view when the caller supplies `?companyId=<uuid>`

Launcher-backed bridge calls also carry `renderEnvironment` metadata so a worker
can tell whether it was invoked from a page, modal, drawer, or popover host shell.

## 10.1 Manifest Shape

Normative manifest shape:

```ts
export interface PaperclipPluginManifestV1 {
  id: string;
  apiVersion: 1;
  version: string;
  displayName: string;
  description: string;
  /** Author name (max 200 chars). May include email: "Jane Doe <jane@example.com>". */
  author: string;
  categories: Array<"connector" | "workspace" | "automation" | "ui">;
  minimumPaperclipVersion?: string;
  capabilities: string[];
  entrypoints: {
    worker: string;
    ui?: string;
  };
  instanceConfigSchema?: JsonSchema;
  jobs?: PluginJobDeclaration[];
  webhooks?: PluginWebhookDeclaration[];
  tools?: Array<{
    name: string;
    displayName: string;
    description: string;
    parametersSchema: JsonSchema;
  }>;
  ui?: {
    slots: Array<{
      type:
        | "page"
        | "detailTab"
        | "taskDetailView"
        | "dashboardWidget"
        | "sidebar"
        | "sidebarPanel"
        | "projectSidebarItem"
        | "toolbarButton"
        | "contextMenuItem"
        | "settingsPage";
      id: string;
      displayName: string;
      /** Which export name in the UI bundle provides this component */
      exportName: string;
      /** For detailTab, taskDetailView, contextMenuItem, projectSidebarItem: which entity types this slot targets (required for these types; projectSidebarItem must include "project") */
      entityTypes?: Array<"project" | "issue" | "agent" | "goal" | "run">;
    }>;
  };
}
```

Rules:

- `id` must be globally unique
- `id` should normally equal the npm package name
- `id` must start with a lowercase alphanumeric character and contain only lowercase letters, digits, dots (`-`), hyphens (`-`), or underscores (`_`)
- `apiVersion` must match the host-supported plugin API version (currently `1`)
- `version` must be a valid semver string (e.g. `"1.2.3"`)
- `author` is required; max 200 characters; may include email in angle brackets (e.g. `"Jane Doe <jane@example.com>"`)
- `displayName` must be 1–100 characters
- `description` must be 1–500 characters
- `minimumPaperclipVersion`, when provided, must be a valid semver string without a leading `v`
- `capabilities` must be static and install-time visible
- config schema must be JSON Schema compatible
- `entrypoints.ui` points to the directory containing the built UI bundle
- `entrypoints.ui` is required when `ui.slots` is declared
- the current host expects `entrypoints.ui/index.js` to be the importable ESM entry module for all declared UI slots
- `ui.slots` declares which extension slots the plugin fills, so the host knows what to mount without loading the bundle eagerly; each slot references an `exportName` from the UI bundle
- declared features (tools, jobs, webhooks, UI slots) must be accompanied by the corresponding capability declaration
- install must fail if `apiVersion` is unsupported or if `minimumPaperclipVersion` is greater than the running Paperclip host version

## 11. Agent Tools

Plugins may contribute tools that Paperclip agents can use during runs.

### 11.1 Tool Declaration

Plugins declare tools in their manifest:

```ts
tools?: Array<{
  name: string;
  displayName: string;
  description: string;
  parametersSchema: JsonSchema;
}>;
```

Tool names are automatically namespaced by plugin ID at runtime (e.g. `linear:search-issues`), so plugins cannot shadow core tools or each other's tools.

### 11.2 Tool Execution

When an agent invokes a plugin tool during a run, the host routes the call to the plugin worker via a `executeTool` RPC method:

- `executeTool(input)` — receives tool name, parsed parameters, and run context (agent ID, run ID, company ID, project ID)

The worker executes the tool logic and returns a typed result. The host enforces capability gates — a plugin must declare `agent.tools.register` to contribute tools, and individual tools may require additional capabilities (e.g. `http.outbound` for tools that call external APIs).

### 11.3 Tool Availability

Plugin tools are only available inside companies where the plugin is enabled. Within an enabled company, the operator may further restrict tool availability per agent or per project through plugin configuration.

Plugin tools appear in the agent's tool list alongside core tools but are visually distinguished in the UI as plugin-contributed.

### 11.4 Constraints

- Plugin tools must not override or shadow core tools by name.
- Plugin tools must be idempotent where possible.
- Tool execution is subject to the same timeout and resource limits as other plugin worker calls.
- Tool results are included in run logs.

## 12. Runtime Model

## 12.1 Process Model

Third-party plugins run out-of-process by default.

Default runtime:

- Paperclip server starts one worker process per installed plugin
- the worker process is a Node process
- host and worker communicate over JSON-RPC on stdio

This design provides:

- failure isolation
- clearer logging boundaries
- easier resource limits
- a cleaner trust boundary than arbitrary in-process execution

## 12.2 Host Responsibilities

The host is responsible for:

- package install
- manifest validation
- capability enforcement
- process supervision
- job scheduling
- webhook routing
- activity log writes
- secret resolution
- UI route registration

## 12.3 Worker Responsibilities

The plugin worker is responsible for:

- validating its own config
- handling domain events
- handling scheduled jobs
- handling webhooks
- serving data and handling actions for the plugin's own UI via `getData` and `performAction`
- invoking host services through the SDK
- reporting health information

## 12.4 Failure Policy

If a worker fails:

- mark plugin status `error`
- surface error in plugin health UI
- keep the rest of the instance running
- retry start with bounded backoff
- do not drop other plugins or core services

## 12.5 Graceful Shutdown Policy

When the host needs to stop a plugin worker (for upgrade, uninstall, or instance shutdown):

1. The host sends `shutdown()` to the worker.
2. The worker has 10 seconds to finish in-flight work and exit cleanly.
3. If the worker does not exit within the deadline, the host sends SIGTERM.
4. If the worker does not exit within 5 seconds after SIGTERM, the host sends SIGKILL.
5. Any in-flight job runs are marked `cancelled` with a note indicating forced shutdown.
6. Any in-flight `getData` or `performAction` calls return an error to the bridge.

The shutdown deadline should be configurable per-plugin in plugin config for plugins that need longer drain periods.

## 13. Host-Worker Protocol

The host must support the following worker RPC methods.

Required methods:

- `initialize(input)`
- `health()`
- `shutdown()`

Optional methods:

- `validateConfig(input)`
- `configChanged(input)`
- `onEvent(input)`
- `runJob(input)`
- `handleWebhook(input)`
- `getData(input)`
- `performAction(input)`
- `executeTool(input)`

### 13.1 `initialize`

Called once on worker startup.

Input includes:

- plugin manifest
- resolved plugin config
- instance info
- host API version

### 13.2 `health`

Returns:

- status
- current error if any
- optional plugin-reported diagnostics

### 13.3 `validateConfig`

Runs after config changes and startup.

Returns:

- `ok`
- warnings
- errors

### 13.4 `configChanged`

Called when the operator updates the plugin's instance config at runtime.

Input includes:

- new resolved config

If the worker implements this method, it applies the new config without restarting. If the worker does not implement this method, the host restarts the worker process with the new config (graceful shutdown then restart).

### 13.5 `onEvent`

Receives one typed Paperclip domain event.

Delivery semantics:

- at least once
- plugin must be idempotent
- no global ordering guarantee across all event types
- per-entity ordering is best effort but not guaranteed after retries

### 13.6 `runJob`

Runs a declared scheduled job.

The host provides:

- job key
- trigger source
- run id
- schedule metadata

### 13.7 `handleWebhook`

Receives inbound webhook payload routed by the host.

The host provides:

- endpoint key
- headers
- raw body
- parsed body if applicable
- request id

### 13.8 `getData`

Returns plugin data requested by the plugin's own UI components.

The plugin UI calls the host bridge, which forwards the request to the worker. The worker returns typed JSON that the plugin's own frontend components render.

Input includes:

- data key (plugin-defined, e.g. `"sync-health"`, `"issue-detail"`)
- context (company id, project id, entity id, etc.)
- optional query parameters

### 13.9 `performAction`

Runs an explicit plugin action initiated by the board UI.

Examples:

- "resync now"
- "link GitHub issue"
- "create branch from issue"
- "restart process"

### 13.10 `executeTool`

Runs a plugin-contributed agent tool during a run.

The host provides:

- tool name (without plugin namespace prefix)
- parsed parameters matching the tool's declared schema
- run context: agent ID, run ID, company ID, project ID

The worker executes the tool and returns a typed result (string content, structured data, or error).

## 14. SDK Surface

Plugins do not talk to the DB directly.
Plugins do not read raw secret material from persisted config.

The SDK exposed to workers must provide typed host clients.

Required SDK clients:

- `ctx.config`
- `ctx.events`
- `ctx.jobs`
- `ctx.http`
- `ctx.secrets`
- `ctx.assets`
- `ctx.activity`
- `ctx.state`
- `ctx.entities`
- `ctx.projects`
- `ctx.issues`
- `ctx.agents`
- `ctx.goals`
- `ctx.data`
- `ctx.actions`
- `ctx.tools`
- `ctx.logger`

`ctx.data` and `ctx.actions` register handlers that the plugin's own UI calls through the host bridge. `ctx.data.register(key, handler)` backs `usePluginData(key)` on the frontend. `ctx.actions.register(key, handler)` backs `usePluginAction(key)`.

Plugins that need filesystem, git, terminal, or process operations handle those directly using standard Node APIs or libraries. The host provides project workspace metadata through `ctx.projects` so plugins can resolve workspace paths, but the host does not proxy low-level OS operations.

## 14.1 Example SDK Shape

```ts
/** Top-level helper for defining a plugin with type checking */
export function definePlugin(definition: PluginDefinition): PaperclipPlugin;

/** Re-exported from Zod for config schema definitions */
export { z } from "zod";

export interface PluginContext {
  manifest: PaperclipPluginManifestV1;
  config: {
    get(): Promise<Record<string, unknown>>;
  };
  events: {
    on(name: string, fn: (event: unknown) => Promise<void>): void;
    on(name: string, filter: EventFilter, fn: (event: unknown) => Promise<void>): void;
    emit(name: string, payload: unknown): Promise<void>;
  };
  jobs: {
    register(key: string, input: { cron: string }, fn: (job: PluginJobContext) => Promise<void>): void;
  };
  state: {
    get(input: ScopeKey): Promise<unknown | null>;
    set(input: ScopeKey, value: unknown): Promise<void>;
    delete(input: ScopeKey): Promise<void>;
  };
  entities: {
    upsert(input: PluginEntityUpsert): Promise<void>;
    list(input: PluginEntityQuery): Promise<PluginEntityRecord[]>;
  };
  data: {
    register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void;
  };
  actions: {
    register(key: string, handler: (params: Record<string, unknown>) => Promise<unknown>): void;
  };
  tools: {
    register(name: string, input: PluginToolDeclaration, fn: (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>): void;
  };
  logger: {
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;
    debug(message: string, meta?: Record<string, unknown>): void;
  };
}

export interface EventFilter {
  projectId?: string;
  companyId?: string;
  agentId?: string;
  [key: string]: unknown;
}
```

## 15. Capability Model

Capabilities are mandatory and static.
Every plugin declares them up front.

The host enforces capabilities in the SDK layer and refuses calls outside the granted set.

## 15.1 Capability Categories

### Data Read

- `companies.read`
- `projects.read`
- `project.workspaces.read`
- `issues.read`
- `issue.comments.read`
- `agents.read`
- `goals.read`
- `activity.read`
- `costs.read`

### Data Write

- `issues.create`
- `issues.update`
- `issue.comments.create`
- `assets.write`
- `assets.read`
- `activity.log.write`
- `metrics.write`

### Plugin State

- `plugin.state.read`
- `plugin.state.write`

### Runtime / Integration

- `events.subscribe`
- `events.emit`
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`

### Agent Tools

- `agent.tools.register`

### UI

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register`
- `ui.dashboardWidget.register`
- `ui.action.register`

## 15.2 Forbidden Capabilities

The host must not expose capabilities for:

- approval decisions
- budget override
- auth bypass
- issue checkout lock override
- direct DB access

## 15.3 Upgrade Rules

If a plugin upgrade adds capabilities:

1. the host must mark the plugin `upgrade_pending`
2. the operator must explicitly approve the new capability set
3. the new version does not become `ready` until approval completes

## 16. Event System

The host must emit typed domain events that plugins may subscribe to.

Minimum event set:

- `company.created`
- `company.updated`
- `project.created`
- `project.updated`
- `project.workspace_created`
- `project.workspace_updated`
- `project.workspace_deleted`
- `issue.created`
- `issue.updated`
- `issue.comment.created`
- `agent.created`
- `agent.updated`
- `agent.status_changed`
- `agent.run.started`
- `agent.run.finished`
- `agent.run.failed`
- `agent.run.cancelled`
- `approval.created`
- `approval.decided`
- `cost_event.created`
- `activity.logged`

Each event must include:

- event id
- event type
- occurred at
- actor metadata when applicable
- primary entity metadata
- typed payload

### 16.1 Event Filtering

Plugins may provide an optional filter when subscribing to events. The filter is evaluated by the host before dispatching to the worker, so filtered-out events never cross the process boundary.

Supported filter fields:

- `projectId` — only receive events for a specific project
- `companyId` — only receive events for a specific company
- `agentId` — only receive events for a specific agent

Filters are optional. If omitted, the plugin receives all events of the subscribed type. Filters may be combined (e.g. filter by both company and project).

### 16.2 Plugin-to-Plugin Events

Plugins may emit custom events using `ctx.events.emit(name, payload)`. Plugin-emitted events use a namespaced event type: `plugin.<pluginId>.<eventName>`.

Other plugins may subscribe to these events using the same `ctx.events.on()` API:

```ts
ctx.events.on("plugin.@paperclip/plugin-git.push-detected", async (event) => {
  // react to the git plugin detecting a push
});
```

Rules:

- Plugin events require the `events.emit` capability.
- Plugin events are not core domain events — they do not appear in the core activity log unless the emitting plugin explicitly logs them.
- Plugin events follow the same at-least-once delivery semantics as core events.
- The host must not allow plugins to emit events in the core namespace (events without the `plugin.` prefix).
- Plugins must not pass the `plugin.` prefix when calling `ctx.events.emit()` — the host adds it automatically. Passing the prefix is an error.

### 16.3 Wildcard Subscriptions

The host supports trailing-wildcard subscriptions in the `plugin.*` namespace:

- `"plugin.<pluginId>.*"` — subscribes to all events from a specific plugin.
- `"plugin.*"` — subscribes to all plugin-emitted events regardless of source plugin.

Wildcard patterns use `.*` as the only supported glob token. They must appear at the end of the pattern and may not be used within core domain event names (e.g. `"issue.*"` is not valid — subscribe by exact name).

Wildcard subscriptions require the `events.subscribe` capability, same as exact subscriptions.

## 17. Scheduled Jobs

Plugins may declare scheduled jobs in their manifest.

Job rules:

1. Each job has a stable `job_key`.
2. The host is the scheduler of record.
3. The host prevents overlapping execution of the same plugin/job combination unless explicitly allowed later.
4. Every job run is recorded in Postgres.
5. Failed jobs are retryable.

## 18. Webhooks

Plugins may declare webhook endpoints in their manifest.

Webhook route shape:

- `POST /api/plugins/:pluginId/webhooks/:endpointKey`

Rules:

1. The host owns the public route.
2. The worker receives the request body through `handleWebhook`.
3. Signature verification happens in plugin code using secret refs resolved by the host.
4. Every delivery is recorded.
5. Webhook handling must be idempotent.

## 19. UI Extension Model

Plugins ship their own frontend UI as a bundled React module. The host loads plugin UI into designated extension slots and provides a bridge for the plugin frontend to communicate with its own worker backend and with host APIs.

### How Plugin UI Publishing Works In Practice

A plugin's `dist/ui/` directory contains a built React bundle. The host serves this bundle and loads it into the page when the user navigates to a plugin surface (a plugin page, a detail tab, a dashboard widget, etc.).

**The host provides, the plugin renders:**

1. The host defines **extension slots** — designated mount points in the UI where plugin components can appear (pages, tabs, widgets, sidebar entries, sidebar link under each project (project sidebar item), action bars).
2. The plugin's UI bundle exports named components for each slot it wants to fill.
3. The host mounts the plugin component into the slot, passing it a **host bridge** object.
4. The plugin component uses the bridge to fetch data from its own worker (via `getData`), call actions (via `performAction`), read host context (current company, project, entity), and use shared host UI primitives (design tokens, common components).

**Concrete example: a Linear plugin ships a dashboard widget.**

The plugin's UI bundle exports:

```tsx
// dist/ui/index.tsx
import { usePluginData, usePluginAction, MetricCard, StatusBadge } from "@paperclipai/plugin-sdk/ui";

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading } = usePluginData("sync-health", { companyId: context.companyId });
  const resync = usePluginAction("resync");

  if (loading) return <Spinner />;

  return (
    <div>
      <MetricCard label="Synced Issues" value={data.syncedCount} trend={data.trend} />
      {data.mappings.map(m => (
        <StatusBadge key={m.id} label={m.label} status={m.status} />
      ))}
      <button onClick={() => resync({ companyId: context.companyId })}>Resync Now</button>
    </div>
  );
}
```

**What happens at runtime:**

1. User opens the dashboard. The host sees that the Linear plugin registered a `DashboardWidget` export.
2. The host mounts the plugin's `DashboardWidget` component into the dashboard widget slot, passing `context` (current company, user, etc.) and the bridge.
3. `usePluginData("sync-health", ...)` calls through the bridge → host → plugin worker's `getData` RPC → returns JSON → the plugin component renders it however it wants.
4. When the user clicks "Resync Now", `usePluginAction("resync")` calls through the bridge → host → plugin worker's `performAction` RPC.

**What the host controls:**

- The host decides **where** plugin components appear (which slots exist and when they mount).
- The host provides the **bridge** — plugin UI cannot make arbitrary network requests or access host internals directly.
- The host enforces **capability gates** — if a plugin's worker does not have a capability, the bridge rejects the call even if the UI requests it.
- The host provides **design tokens and shared components** via `@paperclipai/plugin-sdk/ui` so plugins can match the host's visual language without being forced to.

**What the plugin controls:**

- The plugin decides **how** to render its data — it owns its React components, layout, interactions, and state management.
- The plugin decides **what data** to fetch and **what actions** to expose.
- The plugin can use any React patterns (hooks, context, third-party component libraries) inside its bundle.

### 19.0.1 Plugin UI SDK (`@paperclipai/plugin-sdk/ui`)

The SDK includes a `ui` subpath export that plugin frontends import. This subpath provides:

- **Bridge hooks**: `usePluginData(key, params)`, `usePluginAction(key)`, `useHostContext()`
- **Design tokens**: colors, spacing, typography, shadows matching the host theme
- **Shared components**: `MetricCard`, `StatusBadge`, `DataTable`, `LogView`, `ActionBar`, `Spinner`, etc.
- **Type definitions**: `PluginPageProps`, `PluginWidgetProps`, `PluginDetailTabProps`

Plugins are encouraged but not required to use the shared components. A plugin may render entirely custom UI as long as it communicates through the bridge.

### 19.0.2 Bundle Isolation

Plugin UI bundles are loaded as standard ES modules, not iframed. This gives plugins full rendering performance and access to the host's design tokens.

Isolation rules:

- Plugin bundles must not import from host internals. They may only import from `@paperclipai/plugin-sdk/ui` and their own dependencies.
- Plugin bundles must not access `window.fetch` or `XMLHttpRequest` directly for host API calls. All host communication goes through the bridge.
- The host may enforce Content Security Policy rules that restrict plugin network access to the bridge endpoint only.
- Plugin bundles must be statically analyzable — no dynamic `import()` of URLs outside the plugin's own bundle.

If stronger isolation is needed later, the host can move to iframe-based mounting for untrusted plugins without changing the plugin's source code (the bridge API stays the same).

### 19.0.3 Bundle Serving

Plugin UI bundles must be pre-built ESM. The host does not compile or transform plugin UI code at runtime.

The host serves the plugin's `dist/ui/` directory as static assets under a namespaced path:

- `/_plugins/:pluginId/ui/*`

When the host renders an extension slot, it dynamically imports the plugin's UI entry module from this path, resolves the named export declared in `ui.slots[].exportName`, and mounts it into the slot.

In development, the host may support a `devUiUrl` override in plugin config that points to a local dev server (e.g. Vite) so plugin authors can use hot-reload during development without rebuilding.

### 19.0.4 Current UI Support Matrix

The manifest schema recognizes more slot types than the host currently mounts. Authors should treat the following matrix as the V1 contract for this branch.

| Slot Type | Current Host Support | Current Mount Point | Typical Launcher / Navigation Path | Required Capability |
|---|---|---|---|---|
| `settingsPage` | Supported | Instance plugin detail page | `/settings/plugins/:pluginId` | `instance.settings.register` |
| `sidebar` | Supported | Main sidebar navigation area | Always-visible host sidebar | `ui.sidebar.register` |
| `sidebarPanel` | Supported | Main sidebar panel area | Always-visible host sidebar | `ui.sidebar.register` |
| `projectSidebarItem` | Supported | Under each project row in the sidebar | Click-through to project route or plugin tab | `ui.sidebar.register` |
| `toolbarButton` | Supported | Breadcrumb/header action area | Current page header | `ui.action.register` |
| `detailTab` | Supported | Project detail and issue detail | Host tab bar or `?tab=plugin:<pluginKey>:<slotId>` | `ui.detailTab.register` |
| `taskDetailView` | Supported | Project detail and issue detail plugin tab surfaces | Host tab bar or `?tab=plugin:<pluginKey>:<slotId>` | `ui.detailTab.register` |
| `contextMenuItem` | Supported | Issue detail "More" menu | Issue actions popover | `ui.action.register` |
| `page` | Supported | Company-context page at `/:companyPrefix/plugins/:pluginId` | `/:companyPrefix/plugins/:pluginId` | `ui.page.register` |
| `dashboardWidget` | Supported | Dashboard (below chart cards) | Dashboard page | `ui.dashboardWidget.register` |

Entity-type support is narrower than the manifest union:

- `project`: supported for `detailTab`, `taskDetailView`, and `projectSidebarItem`
- `issue`: supported for `detailTab`, `taskDetailView`, and `contextMenuItem`
- `agent`: supported for `detailTab` and `taskDetailView` (Agent detail page; plugin tabs via `?tab=plugin:<pluginKey>:<slotId>`)
- `goal`: supported for `detailTab` and `taskDetailView` (Goal detail page; plugin tabs via `?tab=plugin:<pluginKey>:<slotId>`)
- `run`: accepted in manifest types for forward compatibility, but not mounted by the current UI

When a slot type is "declared in schema, not mounted", install may still succeed, but the operator should expect no visible frontend surface until the host adds a matching mount point.

## 19.1 Global Operator Routes

- `/settings/plugins`
- `/settings/plugins/:pluginId`

These routes are instance-level.

## 19.2 Company-Context Routes

- `/:companyPrefix/plugins/:pluginId`

When a plugin declares a `page` slot and is enabled for that company, the host mounts the plugin's page component at this route. These routes exist because the board UI is organized around companies even though plugin installation is global.

## 19.3 Detail Tabs

Plugins may add tabs to:

- project detail
- issue detail
- agent detail
- goal detail
- run detail

Recommended route pattern:

- `/:companyPrefix/<entity>/:id?tab=<plugin-tab-id>`

Launcher conventions in the current UI:

- Project tabs launch from `/projects/:projectRef?tab=plugin:<pluginKey>:<slotId>`
- Issue tabs launch from the issue detail tab strip; URL synchronization may vary by page
- Agent tabs launch from `/agents/:agentId?tab=plugin:<pluginKey>:<slotId>`
- Goal tabs launch from `/goals/:goalId?tab=plugin:<pluginKey>:<slotId>`
- `projectSidebarItem` should usually deep-link to a corresponding `detailTab` or `taskDetailView`, not try to create a separate standalone page flow

## 19.4 Dashboard Widgets

Plugins may add cards or sections to the dashboard. The host mounts a dashboard widget outlet on the Dashboard page (below the chart cards); each plugin that declares a `dashboardWidget` slot appears there with card-style layout.

## 19.5 Sidebar Entries

Plugins may add sidebar links to:

- global plugin settings
- company-context plugin pages

Plugins may also add sidebar links **under each project** via the `projectSidebarItem` slot type; see §19.5.1.

### 19.5.1 Project sidebar items

The `projectSidebarItem` slot type lets a plugin add a menu link under each project in the sidebar Projects list. The host renders one instance per project and passes that project’s id (and company context) in the slot context.

- **Mount point:** Under each project row in the sidebar Projects list.
- **Context:** The slot is project-entity-scoped. The host passes `entityType: "project"` and `entityId: <project id>` in the context when rendering. The plugin component receives the same bridge and host context as other slots; `context.entityId` is the current project id, `context.entityType` is `"project"`.
- **Manifest:** In `ui.slots`, use `type: "projectSidebarItem"`. `entityTypes` is **required** and must include `"project"` (only project is meaningful for this slot). The plugin must declare the `ui.sidebar.register` capability.
- **Recommended behaviour:** The component should render a single link (or compact row) to a plugin page or project tab (e.g. `/:companyPrefix/projects/:projectRef` or `?tab=<plugin-tab-id>`).

### 19.5.2 Modal And Drawer Behavior

V1 does not define a dedicated modal, dialog, or drawer slot type. Plugins are launched from existing host surfaces such as tabs, sidebar items, toolbar buttons, settings pages, and context menus.

Current behavior expectations:

- Plugin components render inline inside the host surface that mounted them.
- A plugin may open its own modal or drawer from within that surface, but the host does not manage plugin modal lifecycle or routing.
- Plugin UI must not assume it owns the page-level overlay stack. It may be rendered inside host-managed containers such as tabs, popovers, or pages that themselves can appear in sheets/drawers on mobile.
- Plugin interactions must not rely on dismissing or mutating the host's parent dialog state except through explicit bridge actions exposed by the host.
- If a plugin opens overlays, it should ensure keyboard escape handling, focus trapping, and portal/z-index behavior do not interfere with the host shell.

For operator UX, plugins should prefer deep-linkable pages or tabs for primary workflows and reserve plugin-owned modals for short, local interactions such as confirmations, pickers, and compact editors.

## 19.6 Shared Components In `@paperclipai/plugin-sdk/ui`

The host SDK ships shared components that plugins can import to quickly build UIs that match the host's look and feel. These are convenience building blocks, not a requirement.

| Component | What it renders | Typical use |
|---|---|---|
| `MetricCard` | Single number with label, optional trend/sparkline | KPIs, counts, rates |
| `StatusBadge` | Inline status indicator (ok/warning/error/info) | Sync health, connection status |
| `DataTable` | Rows and columns with optional sorting and pagination | Issue lists, job history, process lists |
| `TimeseriesChart` | Line or bar chart with timestamped data points | Revenue trends, sync volume, error rates |
| `MarkdownBlock` | Rendered markdown text | Descriptions, help text, notes |
| `KeyValueList` | Label/value pairs in a definition-list layout | Entity metadata, config summary |
| `ActionBar` | Row of buttons wired to `usePluginAction` | Resync, create branch, restart process |
| `LogView` | Scrollable log output with timestamps | Webhook deliveries, job output, process logs |
| `JsonTree` | Collapsible JSON tree for debugging | Raw API responses, plugin state inspection |
| `Spinner` | Loading indicator | Data fetch states |

Plugins may also use entirely custom components. The shared components exist to reduce boilerplate and keep visual consistency, not to limit what plugins can render.

## 19.7 Error Propagation Through The Bridge

The bridge hooks must return structured errors so plugin UI can handle failures gracefully.

`usePluginData` returns:

```ts
{
  data: T | null;
  loading: boolean;
  error: PluginBridgeError | null;
}
```

`usePluginAction` returns an async function that either resolves with the result or throws a `PluginBridgeError`.

`PluginBridgeError` shape:

```ts
interface PluginBridgeError {
  code: "WORKER_UNAVAILABLE" | "CAPABILITY_DENIED" | "WORKER_ERROR" | "TIMEOUT" | "UNKNOWN";
  message: string;
  /** Original error details from the worker, if available */
  details?: unknown;
}
```

Error codes:

- `WORKER_UNAVAILABLE` — the plugin worker is not running (crashed, shutting down, not yet started)
- `CAPABILITY_DENIED` — the plugin does not have the required capability for this operation
- `WORKER_ERROR` — the worker returned an error from its `getData` or `performAction` handler
- `TIMEOUT` — the worker did not respond within the configured timeout
- `UNKNOWN` — unexpected bridge-level failure

The `@paperclipai/plugin-sdk/ui` subpath should also export an `ErrorBoundary` component that plugin authors can use to catch rendering errors without crashing the host page.

## 19.8 Plugin Settings UI

Each plugin that declares an `instanceConfigSchema` in its manifest gets an auto-generated settings form at `/settings/plugins/:pluginId`. The host renders the form from the JSON Schema.

The auto-generated form supports:

- text inputs, number inputs, toggles, select dropdowns derived from schema types and enums
- nested objects rendered as fieldsets
- arrays rendered as repeatable field groups with add/remove controls
- secret ref fields: any schema property annotated with `"format": "secret-ref"` renders as a secret picker that resolves through the Paperclip secret provider system rather than a plain text input
- validation messages derived from schema constraints (`required`, `minLength`, `pattern`, `minimum`, etc.)
- a "Test Connection" action if the plugin declares a `validateConfig` RPC method — the host calls it and displays the result inline

For plugins that need richer settings UX beyond what JSON Schema can express, the plugin may declare a `settingsPage` slot in `ui.slots`. When present, the host renders the plugin's own React component instead of the auto-generated form. The plugin component communicates with its worker through the standard bridge to read and write config.

Both approaches coexist: a plugin can use the auto-generated form for simple config and add a custom settings page slot for advanced configuration or operational dashboards.

## 20. Local Tooling

Plugins that need filesystem, git, terminal, or process operations implement those directly. The host does not wrap or proxy these operations.

The host provides workspace metadata through `ctx.projects` (list workspaces, get primary workspace, resolve workspace from issue or agent/run). Plugins use this metadata to resolve local paths and then operate on the filesystem, spawn processes, shell out to `git`, or open PTY sessions using standard Node APIs or any libraries they choose.

This keeps the host lean — it does not need to maintain a parallel API surface for every OS-level operation a plugin might need. Plugins own their own logic for file browsing, git workflows, terminal sessions, and process management.

## 21. Persistence And Postgres

## 21.1 Database Principles

1. Core Paperclip data stays in first-party tables.
2. Most plugin-owned data starts in generic extension tables.
3. Plugin data should scope to existing Paperclip objects before new tables are introduced.
4. Arbitrary third-party schema migrations are out of scope for the first plugin system.

## 21.2 Core Table Reuse

If data becomes part of the actual Paperclip product model, it should become a first-party table.

Examples:

- `project_workspaces` is already first-party
- if Paperclip later decides git state is core product data, it should become a first-party table too

## 21.3 Required Tables

### `plugins`

- `id` uuid pk
- `plugin_key` text unique not null
- `package_name` text not null
- `version` text not null
- `api_version` int not null
- `categories` text[] not null
- `manifest_json` jsonb not null
- `status` enum: `installed | ready | error | upgrade_pending`
- `install_order` int null
- `installed_at` timestamptz not null
- `updated_at` timestamptz not null
- `last_error` text null

Indexes:

- unique `plugin_key`
- `status`

### `plugin_config`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` unique not null
- `config_json` jsonb not null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null
- `last_error` text null

### `plugin_company_settings`

- `id` uuid pk
- `company_id` uuid fk `companies.id` not null
- `plugin_id` uuid fk `plugins.id` not null
- `enabled` boolean not null default true
- `settings_json` jsonb not null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null
- `last_error` text null

Constraints:

- unique `(company_id, plugin_id)`

Semantics:

- stores company-scoped plugin settings and availability
- absence of the row means the plugin is enabled for that company by default
- a row with `enabled = true` stores company settings while keeping the plugin enabled
- a row with `enabled = false` explicitly disables the plugin for that company while preserving any company-scoped settings

### `plugin_state`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `scope_kind` enum: `instance | company | project | project_workspace | agent | issue | goal | run`
- `scope_id` uuid/text null
- `namespace` text not null
- `state_key` text not null
- `value_json` jsonb not null
- `updated_at` timestamptz not null

Constraints:

- unique `(plugin_id, scope_kind, scope_id, namespace, state_key)`

Examples:

- Linear external IDs keyed by `issue`
- GitHub sync cursors keyed by `project`
- file browser preferences keyed by `project_workspace`
- git branch metadata keyed by `project_workspace`
- process metadata keyed by `project_workspace` or `run`

### `plugin_jobs`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `scope_kind` enum nullable
- `scope_id` uuid/text null
- `job_key` text not null
- `schedule` text null
- `status` enum: `idle | queued | running | error`
- `next_run_at` timestamptz null
- `last_started_at` timestamptz null
- `last_finished_at` timestamptz null
- `last_succeeded_at` timestamptz null
- `last_error` text null

Constraints:

- unique `(plugin_id, scope_kind, scope_id, job_key)`

### `plugin_job_runs`

- `id` uuid pk
- `plugin_job_id` uuid fk `plugin_jobs.id` not null
- `plugin_id` uuid fk `plugins.id` not null
- `status` enum: `queued | running | succeeded | failed | cancelled`
- `trigger` enum: `schedule | manual | retry`
- `started_at` timestamptz null
- `finished_at` timestamptz null
- `error` text null
- `details_json` jsonb null

Indexes:

- `(plugin_id, started_at desc)`
- `(plugin_job_id, started_at desc)`

### `plugin_webhook_deliveries`

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `scope_kind` enum nullable
- `scope_id` uuid/text null
- `endpoint_key` text not null
- `status` enum: `received | processed | failed | ignored`
- `request_id` text null
- `headers_json` jsonb null
- `body_json` jsonb null
- `received_at` timestamptz not null
- `handled_at` timestamptz null
- `response_code` int null
- `error` text null

Indexes:

- `(plugin_id, received_at desc)`
- `(plugin_id, endpoint_key, received_at desc)`

### `plugin_entities` (optional but recommended)

- `id` uuid pk
- `plugin_id` uuid fk `plugins.id` not null
- `entity_type` text not null
- `scope_kind` enum not null
- `scope_id` uuid/text null
- `external_id` text null
- `title` text null
- `status` text null
- `data_json` jsonb not null
- `created_at` timestamptz not null
- `updated_at` timestamptz not null

Indexes:

- `(plugin_id, entity_type, external_id)` unique when `external_id` is not null
- `(plugin_id, scope_kind, scope_id, entity_type)`

Use cases:

- imported Linear issues
- imported GitHub issues
- plugin-owned process records
- plugin-owned external metric bindings

## 21.4 Activity Log Changes

The activity log should extend `actor_type` to include `plugin`.

New actor enum:

- `agent`
- `user`
- `system`
- `plugin`

Plugin-originated mutations should write:

- `actor_type = plugin`
- `actor_id = <plugin-id>`

## 21.5 Plugin Migrations

The first plugin system does not allow arbitrary third-party migrations.

Later, if custom tables become necessary, the system may add a trusted-module-only migration path.

## 22. Secrets

Plugin config must never persist raw secret values.

Rules:

1. Plugin config stores secret refs only.
2. Secret refs resolve through the existing Paperclip secret provider system.
3. Plugin workers receive resolved secrets only at execution time.
4. Secret values must never be written to:
   - plugin config JSON
   - activity logs
   - webhook delivery rows
   - error messages

## 23. Auditing

All plugin-originated mutating actions must be auditable.

Minimum requirements:

- activity log entry for every mutation
- job run history
- webhook delivery history
- plugin health page
- install/upgrade history in `plugins`

## 24. Operator UX

## 24.1 Global Settings

Global plugin settings page must show:

- installed plugins
- versions
- status
- requested capabilities
- current errors
- install/upgrade/remove actions

This page manages instance-wide lifecycle only:

- install
- uninstall
- upgrade
- global worker/runtime health
- instance-wide config from `instanceConfigSchema`

It does not control whether a plugin is available inside a specific company.

## 24.2 Company Settings

Company settings must show the installed plugin list for the currently selected company with:

- enabled/disabled state for each installed plugin
- company-scoped settings when the plugin is enabled for that company
- company-scoped validation or availability errors

Route:

- `/company/settings`

Behavior:

- enabling a plugin for the selected company creates or updates `plugin_company_settings`
- disabling a plugin for the selected company persists `plugin_company_settings.enabled = false`
- company-scoped plugin UI surfaces and tool discovery use this availability state

## 24.3 Plugin Settings Page

Each plugin may expose:

- config form derived from `instanceConfigSchema`
- health details
- recent job history
- recent webhook history
- capability list

Route:

- `/settings/plugins/:pluginId`

## 24.4 Company-Context Plugin Page

Each plugin may expose a company-context main page:

- `/:companyPrefix/plugins/:pluginId`

This page is where board users do most day-to-day work.
The route must only be reachable when the plugin is enabled for that company.

## 25. Uninstall And Data Lifecycle

When a plugin is uninstalled, the host must handle plugin-owned data explicitly.

### 25.1 Uninstall Process

1. The host sends `shutdown()` to the worker and follows the graceful shutdown policy.
2. The host marks the plugin status `uninstalled` in the `plugins` table (soft delete).
3. Plugin-owned data (`plugin_state`, `plugin_entities`, `plugin_jobs`, `plugin_job_runs`, `plugin_webhook_deliveries`, `plugin_config`, `plugin_company_settings`) is retained for a configurable grace period (default: 30 days).
4. During the grace period, the operator can reinstall the same plugin and recover its state.
5. After the grace period, the host purges all plugin-owned data for the uninstalled plugin.
6. The operator may force-purge immediately via CLI: `pnpm paperclipai plugin purge <plugin-id>`.

### 25.2 Upgrade Data Considerations

Plugin upgrades do not automatically migrate plugin state. If a plugin's `value_json` shape changes between versions:

- The plugin worker is responsible for migrating its own state on first access after upgrade.
- The host does not run plugin-defined schema migrations.
- Plugins should version their state keys or use a schema version field inside `value_json` to detect and handle format changes.

### 25.3 Upgrade Lifecycle

When upgrading a plugin:

1. The host sends `shutdown()` to the old worker.
2. The host waits for the old worker to drain in-flight work (respecting the shutdown deadline).
3. Any in-flight jobs that do not complete within the deadline are marked `cancelled`.
4. The host installs the new version and starts the new worker.
5. If the new version adds capabilities, the plugin enters `upgrade_pending` and the operator must approve before the new worker becomes `ready`.

### 25.4 Hot Plugin Lifecycle

Plugin install, uninstall, upgrade, and config changes **must** take effect without restarting the Paperclip server. This is a normative requirement, not optional.

The architecture already supports this — plugins run as out-of-process workers with dynamic ESM imports, IPC bridges, and host-managed routing tables. This section makes the requirement explicit so implementations do not regress.

#### 25.4.1 Hot Install

When a plugin is installed at runtime:

1. The host resolves and validates the manifest without stopping existing services.
2. The host spawns a new worker process for the plugin.
3. The host registers the plugin's event subscriptions, job schedules, webhook endpoints, and agent tool declarations in the live routing tables.
4. The host loads the plugin's UI bundle path into the extension slot registry so the frontend can discover it on the next navigation or via a live notification.
5. The plugin enters `ready` status (or `upgrade_pending` if capability approval is required).

No other plugin or host service is interrupted.

#### 25.4.2 Hot Uninstall

When a plugin is uninstalled at runtime:

1. The host sends `shutdown()` and follows the graceful shutdown policy (Section 12.5).
2. The host removes the plugin's event subscriptions, job schedules, webhook endpoints, and agent tool declarations from the live routing tables.
3. The host removes the plugin's UI bundle from the extension slot registry. Any currently mounted plugin UI components are unmounted and replaced with a placeholder or removed entirely.
4. The host marks the plugin `uninstalled` and starts the data retention grace period (Section 25.1).

No server restart is needed.

#### 25.4.3 Hot Upgrade

When a plugin is upgraded at runtime:

1. The host follows the upgrade lifecycle (Section 25.3) — shut down old worker, start new worker.
2. If the new version changes event subscriptions, job schedules, webhook endpoints, or agent tools, the host atomically swaps the old registrations for the new ones.
3. If the new version ships an updated UI bundle, the host invalidates any cached bundle assets and notifies the frontend to reload plugin UI components. Active users see the updated UI on next navigation or via a live refresh notification.
4. If the manifest `apiVersion` is unchanged and no new capabilities are added, the upgrade completes without operator interaction.

#### 25.4.4 Hot Config Change

When an operator updates a plugin's instance config at runtime:

1. The host writes the new config to `plugin_config`.
2. The host sends a `configChanged` notification to the running worker via IPC.
3. The worker receives the new config through `ctx.config` and applies it without restarting. If the plugin needs to re-initialize connections (e.g. a new API token), it does so internally.
4. If the plugin does not handle `configChanged`, the host restarts the worker process with the new config (graceful shutdown then restart).

#### 25.4.5 Frontend Cache Invalidation

The host must version plugin UI bundle URLs (e.g. `/_plugins/:pluginId/ui/:version/*` or content-hash-based paths) so that browser caches do not serve stale bundles after upgrade or reinstall.

The host should emit a `plugin.ui.updated` event that the frontend listens for to trigger re-import of updated plugin modules without a full page reload.

#### 25.4.6 Worker Process Management

The host's plugin process manager must support:

- starting a worker for a newly installed plugin without affecting other workers
- stopping a worker for an uninstalled plugin without affecting other workers
- replacing a worker during upgrade (stop old, start new) atomically from the routing table's perspective
- restarting a worker after crash without operator intervention (with backoff)

Each worker process is independent. There is no shared process pool or batch restart mechanism.

## 26. Plugin Observability

### 26.1 Logging

Plugin workers use `ctx.logger` to emit structured logs. The host captures these logs and stores them in a queryable format.

Log storage rules:

- Plugin logs are stored in a `plugin_logs` table or appended to a log file under the plugin's data directory.
- Each log entry includes: plugin ID, timestamp, level, message, and optional structured metadata.
- Logs are queryable from the plugin settings page in the UI.
- Logs have a configurable retention period (default: 7 days).
- The host captures `stdout` and `stderr` from the worker process as fallback logs even if the worker does not use `ctx.logger`.

### 26.2 Health Dashboard

The plugin settings page must show:

- current worker status (running, error, stopped)
- uptime since last restart
- recent log entries
- job run history with success/failure rates
- webhook delivery history with success/failure rates
- last health check result and diagnostics
- resource usage if available (memory, CPU)

### 26.3 Alerting

The host should emit internal events when plugin health degrades. These use the `plugin.*` namespace (not core domain events) and do not appear in the core activity log:

- `plugin.health.degraded` — worker reporting errors or failing health checks
- `plugin.health.recovered` — worker recovered from error state
- `plugin.worker.crashed` — worker process exited unexpectedly
- `plugin.worker.restarted` — worker restarted after crash

These events can be consumed by other plugins (e.g. a notification plugin) or surfaced in the dashboard.

## 27. Plugin Development And Testing

### 27.1 `@paperclipai/plugin-test-harness`

The host should publish a test harness package that plugin authors use for local development and testing.

The test harness provides:

- a mock host that implements the full SDK interface (`ctx.config`, `ctx.events`, `ctx.state`, etc.)
- ability to send synthetic events and verify handler responses
- ability to trigger job runs and verify side effects
- ability to simulate `getData` and `performAction` calls as if coming from the UI bridge
- ability to simulate `executeTool` calls as if coming from an agent run
- in-memory state and entity stores for assertions
- configurable capability sets for testing capability denial paths

Example usage:

```ts
import { createTestHarness } from "@paperclipai/plugin-test-harness";
import manifest from "../dist/manifest.js";
import { register } from "../dist/worker.js";

const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
await register(harness.ctx);

// Simulate an event
await harness.emit("issue.created", { issueId: "iss-1", projectId: "proj-1" });

// Verify state was written
const state = await harness.state.get({ pluginId: manifest.id, scopeKind: "issue", scopeId: "iss-1", namespace: "sync", stateKey: "external-id" });
expect(state).toBeDefined();

// Simulate a UI data request
const data = await harness.getData("sync-health", { companyId: "comp-1" });
expect(data.syncedCount).toBeGreaterThan(0);
```

### 27.2 Local Plugin Development

For developing a plugin against a running Paperclip instance:

- The operator installs the plugin from a local path: `pnpm paperclipai plugin install ./path/to/plugin`
- The host watches the plugin directory for changes and restarts the worker on rebuild.
- `devUiUrl` in plugin config can point to a local Vite dev server for UI hot-reload.
- The plugin settings page shows real-time logs from the worker for debugging.

### 27.3 Plugin Starter Template

The host should publish a starter template (`create-paperclip-plugin`) that scaffolds:

- `package.json` with correct `paperclipPlugin` keys
- manifest with placeholder values
- worker entry with SDK type imports and example event handler
- UI entry with example `DashboardWidget` using bridge hooks
- test file using the test harness
- build configuration (esbuild or similar) for both worker and UI bundles
- `.gitignore` and `tsconfig.json`

## 28. Example Mappings

This spec directly supports the following plugin types:

- `@paperclip/plugin-workspace-files`
- `@paperclip/plugin-terminal`
- `@paperclip/plugin-git`
- `@paperclip/plugin-linear`
- `@paperclip/plugin-github-issues`
- `@paperclip/plugin-grafana`
- `@paperclip/plugin-runtime-processes`
- `@paperclip/plugin-stripe`

## 29. Compatibility And Versioning

### 29.1 API Version Rules

1. Host supports one or more explicit plugin API versions.
2. Plugin manifest declares exactly one `apiVersion`.
3. Host rejects unsupported versions at install time.
4. Plugin upgrades are explicit operator actions.
5. Capability expansion requires explicit operator approval.

Current branch behavior:

- Only `apiVersion: 1` is accepted.
- Manifest validation enforces `apiVersion` at parse time.
- The loader rejects plugins whose `minimumPaperclipVersion` is newer than the running host version.
- UI bundles are only served while the plugin is in `ready` status, so failed version gates also prevent incompatible UI from mounting.

### 29.2 SDK Versioning

The host publishes a single SDK package for plugin authors:

- `@paperclipai/plugin-sdk` — the complete plugin SDK

The package uses subpath exports to separate worker and UI concerns:

- `@paperclipai/plugin-sdk` — worker-side SDK (context, events, state, tools, logger, `definePlugin`, `runWorker`, `z`)
- `@paperclipai/plugin-sdk/ui` — frontend SDK (bridge hooks, shared components, design tokens)

A single package simplifies dependency management for plugin authors — one dependency, one version, one changelog. The subpath exports keep bundle separation clean: worker code imports from the root, UI code imports from `/ui`. Build tools tree-shake accordingly so the worker bundle does not include React components and the UI bundle does not include worker-only code.

Versioning rules:

1. **Semver**: The SDK follows strict semantic versioning. Major version bumps indicate breaking changes to either the worker or UI surface; minor versions add new features backwards-compatibly; patch versions are bug fixes only.
2. **Tied to API version**: Each major SDK version corresponds to exactly one plugin `apiVersion`. When `@paperclipai/plugin-sdk@2.x` ships, it targets `apiVersion: 2`. Plugins built with SDK 1.x continue to declare `apiVersion: 1`.
3. **Current implementation**: this branch does not yet support multi-version loading. The host currently accepts only `apiVersion: 1`, and manifest-level `sdkVersion` negotiation is deferred.
4. **Future multi-version support**: when a later host release adds `apiVersion: 2+`, the host should support at least the current and one previous `apiVersion` simultaneously. This means plugins built against the previous SDK major version continue to work without modification. The host maintains separate IPC protocol handlers for each supported API version.
5. **Future SDK range declaration**: once implemented, plugins will declare `sdkVersion` in the manifest as a semver range (e.g. `">=1.4.0 <2.0.0"`). The host will validate this at install time and warn if the plugin's declared range is outside the host's supported SDK versions.
6. **Deprecation timeline**: When a new `apiVersion` ships, the previous version enters a deprecation period of at least 6 months. During this period:
   - The host continues to load plugins targeting the deprecated version.
   - The host logs a deprecation warning at plugin startup.
   - The plugin settings page shows a banner indicating the plugin should be upgraded.
   - After the deprecation period ends, the host may drop support for the old version in a future release.
7. **SDK changelog and migration guides**: Each major SDK release must include a migration guide documenting every breaking change, the new API surface, and a step-by-step upgrade path for plugin authors.
8. **UI surface stability**: Breaking changes to shared UI components (removing a component, changing required props) or design tokens require a major version bump just like worker API changes. The single-package model means both surfaces are versioned together, avoiding drift between worker and UI compatibility.

### 29.3 Version Compatibility Matrix

Target-state host docs should publish a compatibility matrix. For the current branch, the effective matrix is:

| Host Version | Supported API Versions | Additional Gating |
|---|---|---|
| current `feature/plugins` branch | `1` | Rejects unsupported `apiVersion`; rejects `minimumPaperclipVersion` above host version |

Future releases should expand this to:

| Host Version | Supported API Versions | SDK Range |
|---|---|---|
| 1.0 | 1 | 1.x |
| 2.0 | 1, 2 | 1.x, 2.x |
| 3.0 | 2, 3 | 2.x, 3.x |

Publishing this matrix via host docs is required. A queryable `GET /api/plugins/compatibility` endpoint is desirable but not yet implemented on this branch.

### 29.4 Plugin Author Workflow

When a new SDK version is released:

1. Plugin author updates `@paperclipai/plugin-sdk` dependency.
2. Plugin author follows the migration guide to update code.
3. Plugin author updates `apiVersion` in the manifest and, once supported by the host, adds or updates `sdkVersion`.
4. Plugin author publishes a new plugin version.
5. Operators upgrade the plugin on their instances. The old version continues to work until explicitly upgraded.

## 30. Recommended Delivery Order

## Phase 1

- plugin manifest
- install/list/remove/upgrade CLI
- global settings UI
- plugin process manager
- capability enforcement
- `plugins`, `plugin_config`, `plugin_state`, `plugin_jobs`, `plugin_job_runs`, `plugin_webhook_deliveries`
- event bus
- jobs
- webhooks
- settings page
- plugin UI bundle loading, host bridge, and `@paperclipai/plugin-sdk/ui`
- extension slot mounting for pages, tabs, widgets, sidebar entries
- bridge error propagation (`PluginBridgeError`)
- auto-generated settings form from `instanceConfigSchema`
- plugin-contributed agent tools
- plugin-to-plugin events (`plugin.<pluginId>.*` namespace)
- event filtering
- graceful shutdown with configurable deadlines
- plugin logging and health dashboard
- `@paperclipai/plugin-test-harness`
- `create-paperclip-plugin` starter template
- uninstall with data retention grace period
- hot plugin lifecycle (install, uninstall, upgrade, config change without server restart)
- SDK versioning with multi-version host support and deprecation policy

This phase is enough for:

- Linear
- GitHub Issues
- Grafana
- Stripe
- file browser
- terminal
- git workflow
- process/server tracking

Workspace plugins (file browser, terminal, git, process tracking) do not require additional host APIs — they resolve workspace paths through `ctx.projects` and handle filesystem, git, PTY, and process operations directly.

## Phase 2

- optional `plugin_entities`
- richer action systems
- trusted-module migration path if truly needed
- iframe-based isolation for untrusted plugin UI bundles
- plugin ecosystem/distribution work

## 31. Final Design Decision

Paperclip should not implement a generic in-process hook bag modeled directly after local coding tools.

Paperclip should implement:

- trusted platform modules for low-level host integration
- globally installed out-of-process plugins for additive instance-wide capabilities
- plugin-contributed agent tools (namespaced, capability-gated)
- plugin-shipped UI bundles rendered in host extension slots via a typed bridge with structured error propagation
- auto-generated settings UI from config schema, with custom settings pages as an option
- plugin-to-plugin events for cross-plugin coordination
- server-side event filtering for efficient event routing
- plugins own their local tooling logic (filesystem, git, terminal, processes) directly
- generic extension tables for most plugin state
- graceful shutdown, uninstall data lifecycle, and plugin observability
- hot plugin lifecycle — install, uninstall, upgrade, and config changes without server restart
- SDK versioning with multi-version host support and a clear deprecation policy
- test harness and starter template for low authoring friction
- strict preservation of core governance and audit rules

That is the complete target design for the Paperclip plugin system.
