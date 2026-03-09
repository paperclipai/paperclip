# Plugin Authoring Guide

This guide walks through building a Paperclip plugin from scratch. It covers the project structure, manifest, worker code, and optional UI components.

**Prerequisites:** Read [PLUGIN_SPEC.md](./PLUGIN_SPEC.md) for the full system design. This guide is the practical companion.
For in-repo first-party reference implementations, see [EXAMPLE_PLUGINS.md](./EXAMPLE_PLUGINS.md).

---

## Table of Contents

1. [Overview](#overview)
2. [Discovery & Installation](#discovery--installation)
   - [Naming Convention](#naming-convention)
   - [Installing a Plugin](#installing-a-plugin)
   - [Publishing to npm](#publishing-to-npm)
   - [Local Development Install](#local-development-install)
3. [Project Structure](#project-structure)
4. [The Manifest](#the-manifest)
5. [Worker Code](#worker-code)
   - [setup()](#setup)
   - [Event Subscriptions](#event-subscriptions)
   - [Scheduled Jobs](#scheduled-jobs)
   - [Secrets and Config](#secrets-and-config)
   - [Plugin State](#plugin-state)
   - [Agent Tools](#agent-tools)
   - [Data and Action Handlers](#data-and-action-handlers)
   - [Lifecycle Hooks](#lifecycle-hooks)
6. [UI Components](#ui-components)
   - [Component Slots](#component-slots)
   - [Bridge Hooks](#bridge-hooks)
   - [Shared Components](#shared-components)
7. [Capabilities Reference](#capabilities-reference)
8. [Testing](#testing)
9. [Common Patterns](#common-patterns)

10. [Upgrading Plugins](#upgrading-plugins)

---

## Overview

A Paperclip plugin is an npm package that the instance operator installs. It runs in a separate Node.js worker process. The host loads your worker module and calls lifecycle methods over an internal JSON-RPC bridge.

For fastest onboarding, start from the official scaffold:

```bash
npx @paperclipai/create-paperclip-plugin my-plugin
```

**Note for AI Agents:**
If you are an AI agent working in this repository, you can use the `paperclip-create-plugin` skill to help you scaffold, implement, and test new plugins. This skill provides detailed workflows, quality bars, and comprehensive reference documentation for the Plugin SDK.

Activate it with: `activate_skill(name: "paperclip-create-plugin")`

The scaffold includes:

- typed manifest + worker entrypoint
- example React UI slot bundle
- test setup using `@paperclipai/plugin-sdk/testing`
- bundling configs using `@paperclipai/plugin-sdk/bundlers` (esbuild + rollup)
- local UI development server wiring with hot-reload events (`paperclip-plugin-dev-server`)

Plugins can:

- **Subscribe to domain events** (issues created, agents spawned, approvals decided, etc.)
- **Contribute agent tools** (tools that Paperclip agents can use in their runs)
- **Add UI extension slots** (dashboard widgets, detail tabs, sidebar entries, pages)
- **Run scheduled jobs**
- **Receive webhooks** from external services
- **Read and write plugin-scoped state** (per-instance, per-company, per-project, etc.)
- **Emit plugin-to-plugin events**

Plugins **cannot**:

- Override core routes or business invariants
- Mutate approval, auth, or budget enforcement logic
- Run arbitrary database migrations
- Access the Paperclip database directly

---

## Discovery & Installation

The plugin loader discovers and installs plugins from two sources: a **local filesystem directory** and **npm packages** that follow the naming convention.

### Naming Convention

All published Paperclip plugins must follow one of these naming patterns:

| Pattern | Example |
|---------|---------|
| `paperclip-plugin-<name>` | `paperclip-plugin-linear` |
| `@<scope>/plugin-<name>` | `@acme/plugin-linear` |

The loader uses the `paperclip-plugin-` prefix (or the `plugin-` local-part for scoped packages) to identify plugin packages in `node_modules`. Packages with a `paperclipPlugin` key in their `package.json` are also recognised regardless of name.

### Installing a Plugin

#### Programmatic install (`pluginLoader.installPlugin`)

The server exposes the `pluginLoader` service for programmatic install:

```ts
import { pluginLoader } from "./services/plugin-loader.js";

const loader = pluginLoader(db);

// Install from npm
const result = await loader.installPlugin({
  packageName: "paperclip-plugin-linear",
  version: "^1.0.0",
});

// Install from a local path (development)
const result = await loader.installPlugin({
  localPath: "/path/to/my-plugin",
});
```

The install process:
1. Resolves the npm package or local directory.
2. Runs `npm install` into `~/.paperclip/plugins/` (npm source only).
3. Reads and validates the plugin manifest.
4. Rejects manifests with an unsupported `apiVersion`.
5. Validates that declared features match declared capabilities.
6. Persists the install record in Postgres via `pluginRegistryService`.
7. Returns a `DiscoveredPlugin` for the caller to pass to the lifecycle manager.

Worker spawning and lifecycle transitions (`installed → ready`) are handled separately by `pluginLifecycleManager`.

#### Manual npm install

To pre-install a plugin without the API:

```bash
npm install paperclip-plugin-linear --prefix ~/.paperclip/plugins
```

The loader scans `~/.paperclip/plugins/node_modules/` automatically on startup and will pick up any package installed there.

### Publishing to npm

To make a plugin installable by any Paperclip instance:

1. Name your package following the convention above.
2. Add a `paperclipPlugin` key to `package.json` pointing to your compiled manifest:

```json
{
  "name": "paperclip-plugin-linear",
  "version": "1.0.0",
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js"
  }
}
```

3. Publish to the npm registry:

```bash
npm publish
```

The manifest module must export the manifest object as its default export. The current in-repo examples and scaffold ship `type: "module"` packages and point `package.json#paperclipPlugin` at compiled `dist/manifest.js`, `dist/worker.js`, and optional `dist/ui/`.

### Local Development Install

For iterating on a plugin locally without publishing to npm, use the `localPath` option in `installPlugin()`. The loader reads the package directory directly without invoking `npm install`, which works well alongside a TypeScript watch process.

The loader also auto-discovers any package in `~/.paperclip/plugins/` whose directory name matches the `paperclip-plugin-*` naming convention, so you can symlink a development build there and have it picked up on the next discovery scan.

For plugin UI development, point plugin config `devUiUrl` to your local dev server. The SDK ships a simple static dev server with hot-reload events:

```bash
paperclip-plugin-dev-server --root . --ui-dir dist/ui --port 4177
```

---

## Project Structure

A typical plugin package looks like this:

```
acme-linear-sync/
├── package.json
├── tsconfig.json
├── src/
│   ├── manifest.ts         # Manifest module — default export is the plugin manifest
│   ├── worker.ts           # Worker entrypoint — default export is a PaperclipPlugin
│   └── ui/
│       └── index.tsx       # UI entrypoint — named exports are React components
└── dist/                   # Compiled output (committed or built by CI)
    ├── manifest.js
    ├── worker.js
    └── ui/
        └── index.js
```

**`package.json`** — current in-repo examples use an ESM package plus an explicit `paperclipPlugin` map:

```json
{
  "name": "@acme/plugin-linear-sync",
  "version": "1.0.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js",
    "ui": "./dist/ui/"
  },
  "dependencies": {
    "@paperclipai/plugin-sdk": "^1.0.0"
  },
  "peerDependencies": {
    "react": ">=18"
  }
}
```

Paperclip discovers the plugin through `package.json#paperclipPlugin.manifest`, validates the exported manifest, and then launches the worker from `paperclipPlugin.worker`.

---

## The Manifest

The manifest module (commonly `src/manifest.ts`, compiled to `dist/manifest.js`) is the authoritative declaration of what your plugin does. The host validates it at install time.

```json
{
  "id": "acme.linear-sync",
  "apiVersion": 1,
  "version": "1.0.0",
  "displayName": "Linear Sync",
  "description": "Bidirectional sync between Paperclip issues and Linear.",
  "author": "Acme Corp <plugins@acme.example>",
  "categories": ["connector"],
  "capabilities": [
    "issues.read",
    "issues.create",
    "issues.update",
    "events.subscribe",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
    "agent.tools.register",
    "ui.dashboardWidget.register"
  ],
  "entrypoints": {
    "worker": "dist/worker.js",
    "ui": "dist/ui"
  },
  "instanceConfigSchema": {
    "type": "object",
    "properties": {
      "apiKeyRef": {
        "type": "string",
        "description": "Name of the secret containing your Linear API key"
      },
      "workspace": {
        "type": "string",
        "description": "Your Linear workspace slug"
      }
    },
    "required": ["apiKeyRef"]
  },
  "jobs": [
    {
      "jobKey": "full-sync",
      "displayName": "Full Sync",
      "description": "Perform a full bidirectional sync with Linear.",
      "schedule": "0 * * * *"
    }
  ],
  "tools": [
    {
      "name": "search-issues",
      "displayName": "Search Linear Issues",
      "description": "Search for issues in Linear by keyword or filter.",
      "parametersSchema": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Search query" },
          "status": { "type": "string", "description": "Filter by status (e.g. 'In Progress')" }
        },
        "required": ["query"]
      }
    }
  ],
  "uiSlots": [
    {
      "slotType": "dashboardWidget",
      "componentExport": "DashboardWidget"
    },
    {
      "slotType": "detailTab",
      "entityTypes": ["issue"],
      "componentExport": "IssueLinearTab"
    }
  ]
}
```

### Manifest Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `id` | ✅ | Globally unique plugin identifier. Typically the npm package name. Format: `^[a-z0-9][a-z0-9._-]*$`. |
| `apiVersion` | ✅ | Must be `1` (current API version). |
| `version` | ✅ | Semver string (e.g. `"1.2.3"`). |
| `displayName` | ✅ | Human-readable name. 1–100 chars. |
| `description` | ✅ | Short description. 1–500 chars. |
| `author` | ✅ | Author name. 1–200 chars. May include email: `"Jane Doe <jane@example.com>"`. |
| `categories` | ✅ | At least one of: `"connector"`, `"workspace"`, `"automation"`, `"ui"`. |
| `capabilities` | ✅ | List of capabilities the plugin requires. Enforced at runtime. |
| `entrypoints.worker` | ✅ | Path to compiled worker JS file. |
| `entrypoints.ui` | When `ui.slots` or `ui.launchers` declared | Path to compiled UI bundle directory. |
| `instanceConfigSchema` | No | JSON Schema for operator-editable configuration. |
| `jobs` | No | Scheduled job declarations. Requires `jobs.schedule` capability. |
| `webhooks` | No | Webhook endpoint declarations. Requires `webhooks.receive` capability. |
| `tools` | No | Agent tool declarations. Requires `agent.tools.register` capability. |
| `uiSlots` | No | UI extension slot declarations. |
| `minimumPaperclipVersion` | No | Minimum Paperclip host version required (semver). |

---

## Worker Code

### setup()

The `setup()` method is the entry point for all worker registration. It is called once when the worker starts. All handler registrations must happen synchronously within `setup()` (or before it resolves).

```ts
// src/worker.ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    // Register everything here
    ctx.logger.info("Plugin starting");
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

**Important:** `setup()` must resolve before the host considers the worker ready. Avoid long-running async work inside `setup()`. Register handlers and return — the handlers themselves run asynchronously later.

### Event Subscriptions

Subscribe to Paperclip domain events using `ctx.events.on()`. The host delivers events asynchronously.

```ts
// Subscribe to all issues created in this instance
ctx.events.on("issue.created", async (event) => {
  ctx.logger.info("Issue created", {
    issueId: event.entityId,
    actorId: event.actorId,
  });
  // event.payload contains the full event data
});

// Subscribe with a filter (server-side — only matching events are dispatched)
ctx.events.on("issue.created", { projectId: "proj-uuid-1" }, async (event) => {
  // Only receives events for this specific project
});

// Subscribe to agent run events
ctx.events.on("agent.run.finished", async (event) => {
  const { agentId, runId, status } = event.payload as {
    agentId: string;
    runId: string;
    status: string;
  };
  await ctx.activity.log({ message: `Agent run ${runId} finished: ${status}` });
});
```

**Available event types** are listed in `PLUGIN_EVENT_TYPES`:

```ts
import { PLUGIN_EVENT_TYPES } from "@paperclipai/plugin-sdk";
// ["company.created", "project.created", "issue.created", "agent.run.started", ...]
```

#### Wildcard subscriptions

Use a trailing `.*` pattern to subscribe to all events from a specific plugin:

```ts
// Receive every event emitted by the acme.linear-sync plugin
ctx.events.on("plugin.acme.linear-sync.*", async (event) => {
  ctx.logger.info("Linear plugin event", { eventType: event.eventType });
});

// Receive every plugin-emitted event from any plugin
ctx.events.on("plugin.*", async (event) => {
  ctx.logger.info("Plugin event received", {
    emitter: event.actorId,
    eventType: event.eventType,
  });
});
```

Wildcard patterns match only within the `plugin.*` namespace. Core domain events (e.g. `issue.created`) must be subscribed to by their exact name.

Requires the `events.subscribe` capability.

### Scheduled Jobs

Declare jobs in the manifest and register handlers in `setup()`:

```ts
// Register a handler for the "full-sync" job declared in the manifest
ctx.jobs.register("full-sync", async (job) => {
  ctx.logger.info("Starting full sync", { runId: job.runId, trigger: job.trigger });

  try {
    await performFullSync(ctx);
    await ctx.state.set(
      { scopeKind: "instance", stateKey: "last-full-sync" },
      new Date().toISOString(),
    );
    await ctx.metrics.write("sync_success_total", 1);
  } catch (err) {
    ctx.logger.error("Full sync failed", { error: String(err) });
    await ctx.metrics.write("sync_failure_total", 1);
    throw err; // re-throw so the host marks the run as failed
  }
});
```

The `job` argument is a `PluginJobContext`:

| Field | Type | Description |
|-------|------|-------------|
| `jobKey` | string | Matches the manifest declaration. |
| `runId` | string | UUID for this specific run. |
| `trigger` | `"schedule" \| "manual" \| "retry"` | What caused this run. |
| `scheduledAt` | string | ISO 8601 timestamp when the run was scheduled. |

Requires the `jobs.schedule` capability.

### Secrets and Config

Never hardcode secrets. The plugin stores a secret **reference** (a name) in its config, and resolves it to the actual value at runtime.

```ts
// In setup(), register a config validator
// (You can also do this inline in onValidateConfig)

// In your event handler or job handler:
async function getApiKey(ctx: PluginContext): Promise<string> {
  const config = await ctx.config.get();
  // config.apiKeyRef is the secret reference name (e.g. "LINEAR_API_KEY")
  return ctx.secrets.resolve(config.apiKeyRef as string);
}
```

**Rules for secrets:**
- Never log, cache, or store resolved secret values.
- Resolve the secret just before use, every time.
- Secrets are resolved through the host's secret provider at runtime.

Requires the `secrets.read-ref` capability.

### Plugin State

Use `ctx.state` to persist key-value data scoped to an instance, company, project, issue, agent, goal, or run. All state is isolated by plugin ID — plugins cannot read or write each other's state.

```ts
// Store the last sync timestamp for a company
await ctx.state.set(
  { scopeKind: "company", scopeId: companyId, stateKey: "last-sync-at" },
  new Date().toISOString(),
);

// Read it back
const lastSync = await ctx.state.get(
  { scopeKind: "company", scopeId: companyId, stateKey: "last-sync-at" },
);
// lastSync is the stored value, or null if not set yet

// Delete it (no-op if the entry does not exist)
await ctx.state.delete(
  { scopeKind: "company", scopeId: companyId, stateKey: "last-sync-at" },
);
```

#### Scope Kinds

Choose the granularity that matches what you are tracking:

| `scopeKind` | When to use | `scopeId` |
|-------------|-------------|-----------|
| `"instance"` | Plugin-global flags, last full-sync timestamps | Omit |
| `"company"` | Per-company sync cursors, company-level configuration | Company UUID |
| `"project"` | Per-project settings, repository metadata | Project UUID |
| `"project_workspace"` | Per-workspace state (e.g. git branch tracking) | Workspace UUID |
| `"agent"` | Per-agent memory or preferences | Agent UUID |
| `"issue"` | Issue-level idempotency keys, linked external IDs | Issue UUID |
| `"goal"` | Per-goal progress tracking | Goal UUID |
| `"run"` | Per-run intermediate results, checkpoints | Run UUID |

For `instance` scope, omit `scopeId`:

```ts
await ctx.state.set({ scopeKind: "instance", stateKey: "schema-version" }, 2);
const v = await ctx.state.get({ scopeKind: "instance", stateKey: "schema-version" }); // 2 or null
```

#### Namespaces

Use the optional `namespace` field to group related keys within a scope without risking collisions. The default namespace is `"default"`. Namespaces are most useful when a plugin tracks multiple integrations per scope:

```ts
// Two integrations sharing a project scope — namespaced to avoid key conflicts
await ctx.state.set(
  { scopeKind: "project", scopeId: projectId, namespace: "linear", stateKey: "sync-cursor" },
  linearCursor,
);
await ctx.state.set(
  { scopeKind: "project", scopeId: projectId, namespace: "github", stateKey: "last-event-id" },
  githubEventId,
);
```

#### State Versioning

If you store structured JSON values and may change their shape in future releases, track a schema version and migrate on first read after an upgrade:

```ts
const SCHEMA_VERSION = 2;

async function getCompanyState(ctx: PluginContext, companyId: string) {
  const version = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: "schema-version" });
  const data = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: "data" });

  if (version !== SCHEMA_VERSION) {
    const migrated = migrate(data, version as number | null);
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: "data" }, migrated);
    await ctx.state.set({ scopeKind: "company", scopeId: companyId, stateKey: "schema-version" }, SCHEMA_VERSION);
    return migrated;
  }

  return data;
}
```

#### Security

Never store resolved secret values in plugin state. Store only the secret *reference* (name) and resolve the actual value via `ctx.secrets.resolve()` at call time:

```ts
// WRONG — never persist a resolved secret
const apiKey = await ctx.secrets.resolve(config.apiKeyRef as string);
await ctx.state.set({ scopeKind: "instance", stateKey: "api-key" }, apiKey); // ❌

// CORRECT — store only the reference, resolve at use time
await ctx.state.set({ scopeKind: "instance", stateKey: "api-key-ref" }, config.apiKeyRef); // ✅
```

State values are JSON-serializable (objects, arrays, strings, numbers, booleans, null).

Requires `plugin.state.read` for `get()` and `plugin.state.write` for `set()` / `delete()`.

### Agent Tools

Plugins can contribute tools that Paperclip agents use during their runs. Tool names are automatically namespaced by plugin ID (e.g. `acme.linear-sync:search-issues`).

```ts
ctx.tools.register(
  "search-issues",                  // must match manifest tool `name`
  {
    displayName: "Search Linear Issues",
    description: "Search for issues in Linear by keyword or filter.",
    parametersSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        status: { type: "string", description: "Filter by status" },
      },
      required: ["query"],
    },
  },
  async (params, runCtx) => {
    const { query, status } = params as { query: string; status?: string };
    const apiKey = await getApiKey(ctx);

    const results = await searchLinear(apiKey, query, status);

    if (results.error) {
      return { error: `Linear search failed: ${results.error}` };
    }

    return {
      content: results.issues
        .map((i) => `- ${i.identifier}: ${i.title} (${i.state})`)
        .join("\n"),
      data: results.issues,
    };
  },
);
```

**Tool handler signature:**

```ts
(params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>
```

`ToolRunContext` provides `agentId`, `runId`, `companyId`, `projectId`.

`ToolResult` has `content?: string` (returned to the agent) and `error?: string` (marks the tool call as failed).

Requires the `agent.tools.register` capability.

### Data and Action Handlers

Register handlers that your UI components call via the bridge:

```ts
// Data handler — called by usePluginData("sync-health", params)
ctx.data.register("sync-health", async ({ companyId }) => {
  const lastSync = await ctx.state.get({
    scopeKind: "company",
    scopeId: String(companyId),
    stateKey: "last-sync-at",
  });
  return {
    lastSync,
    status: lastSync ? "synced" : "never-synced",
    syncedCount: await getSyncedCount(ctx, String(companyId)),
  };
});

// Action handler — called by usePluginAction("resync")()
ctx.actions.register("resync", async ({ companyId }) => {
  ctx.logger.info("Manual resync triggered", { companyId });
  // Queue a sync job or trigger a sync immediately
  await ctx.events.emit("manual-resync", { companyId });
  return { triggered: true };
});
```

### Lifecycle Hooks

All lifecycle hooks are optional. Implement only the ones you need. Your worker file must call `runWorker(plugin, import.meta.url)` at the end so the process stays alive when run as the entrypoint.

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) { /* ... */ },

  // Called on a regular interval to report plugin health.
  // Status appears in the plugin health dashboard.
  async onHealth() {
    try {
      const ping = await testLinearConnection();
      return { status: ping.ok ? "ok" : "degraded", message: ping.message };
    } catch (err) {
      return { status: "error", message: String(err) };
    }
  },

  // Called when the operator saves new configuration.
  // If not implemented, the host restarts the worker instead.
  async onConfigChanged(newConfig) {
    // Re-initialise connections with the new config
    await reinitialiseClient(newConfig);
  },

  // Called before the host terminates the worker.
  // Maximum 10 seconds to resolve.
  async onShutdown() {
    await flushPendingRequests();
    await closeConnections();
  },

  // Called when the operator saves config or clicks "Test Connection".
  // Return errors and warnings to surface them in the UI.
  async onValidateConfig(config) {
    if (!config.apiKeyRef) {
      return { ok: false, errors: ["apiKeyRef is required"] };
    }
    return { ok: true };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

(If you need more lifecycle hooks, add them to the same `definePlugin({ ... })` and keep a single `runWorker(plugin, import.meta.url)` at the end.)

```ts
// Alternative: minimal lifecycle example (same file — import runWorker at top)
const plugin = definePlugin({
  async setup(ctx) { /* ... */ },
  async onValidateConfig(config) {
    if (!config.apiKeyRef) {
      return { ok: false, errors: ["apiKeyRef is required"] };
    }
    try {
      const apiKey = await resolveSecret(config.apiKeyRef as string);
      await testApiKey(apiKey);
      return { ok: true };
    } catch (err) {
      return { ok: false, errors: [String(err)] };
    }
  },

  // Handle inbound webhook deliveries.
  // Verify the signature before processing.
  async onWebhook(input) {
    if (input.endpointKey === "github-push") {
      verifySignature(input.headers, input.rawBody);
      await handlePushEvent(input.parsedBody);
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

---

## UI Components

Plugin UI bundles are React ES modules that render inside host extension slots.
The host discovers these contributions through `GET /api/plugins/ui-contributions`.
UI-only examples such as `@paperclipai/plugin-hello-world-example` use this existing API surface and do not define custom plugin HTTP routes.
The response includes both `slots` and declarative `launchers` for each ready plugin.
In V1, plugins are launched from supported host surfaces such as project sidebar items, toolbar buttons, detail tabs, settings pages, and issue context menus. There is no dedicated host-managed modal slot.

Example discovery payload:

```json
[
  {
    "pluginId": "plg_123",
    "pluginKey": "paperclip.claude-usage",
    "displayName": "Claude Usage",
    "version": "1.0.0",
    "uiEntryFile": "index.js",
    "slots": [],
    "launchers": [
      {
        "id": "claude-usage-toolbar",
        "displayName": "Claude Usage",
        "placementZone": "toolbarButton",
        "action": { "type": "openModal", "target": "ClaudeUsageView" },
        "render": { "environment": "hostOverlay", "bounds": "wide" }
      }
    ]
  }
]
```

### Component Slots

Each UI slot type has a corresponding prop interface:

| Slot type | Interface | Description |
|-----------|-----------|-------------|
| `page` | `PluginPageProps` | Full company-context page at `/:companyPrefix/plugins/:pluginId`. |
| `dashboardWidget` | `PluginWidgetProps` | Dashboard card or section. |
| `detailTab` | `PluginDetailTabProps` | Additional tab on a project/issue/agent/goal/run detail page. |
| `sidebar` | `PluginSidebarProps` | Sidebar link or section. |
| `settingsPage` | `PluginSettingsPageProps` | Custom settings page for the plugin. |
| `projectSidebarItem` | `PluginProjectSidebarItemProps` | Project-scoped launcher rendered under each project row in the sidebar. |

The current UI also mounts `taskDetailView`, `toolbarButton`, `contextMenuItem`, and `sidebarPanel` slots. Those surfaces currently receive the same `context` shape available through `useHostContext()`, so plugin components can author against the hook even when there is not a dedicated exported prop alias yet.

Declare which export name maps to each slot in the manifest `ui.slots` array.

### Declarative Launchers

For host-owned entry points that should open a route, overlay, drawer, popover, or worker action without inventing a new slot component shape, declare `ui.launchers` in the manifest. The host exposes these through the same `GET /api/plugins/ui-contributions` discovery response.

```ts
const manifest: PaperclipPluginManifestV1 = {
  // ...
  capabilities: ["ui.sidebar.register", "ui.detailTab.register"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    launchers: [
      {
        id: "files-sidebar-launcher",
        displayName: "Files",
        placementZone: "projectSidebarItem",
        entityTypes: ["project"],
        action: {
          type: "deepLink",
          target: "plugin:acme.file-tools:files-tab",
        },
      },
    ],
  },
};
```

Use `ui.slots` when you are declaring a concrete React mount point. Use `ui.launchers` when you want the host to render the entry point and drive the navigation or container behavior declaratively.

When launcher-backed UI calls `usePluginData()` or `usePluginAction()`, the host
forwards a `renderEnvironment` snapshot through the bridge. Worker handlers can
use that snapshot to adapt behavior for modal, drawer, popover, or page
presentation without reverse-engineering route state.

### Launcher Example: Project Sidebar Item -> Project Tab

For V1, the most reliable launcher pattern is a small host-mounted surface that deep-links into a richer tab or page. A `projectSidebarItem` is the canonical example because it gives operators a predictable entry point per project.

Manifest:

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "acme.file-tools",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "File Tools",
  description: "Adds a per-project launcher and tab for file operations.",
  author: "Acme <plugins@acme.test>",
  categories: ["workspace", "ui"],
  capabilities: ["ui.sidebar.register", "ui.detailTab.register", "projects.read"],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "projectSidebarItem",
        id: "files-link",
        displayName: "Files",
        exportName: "FilesLauncher",
        entityTypes: ["project"],
        order: 10,
      },
      {
        type: "detailTab",
        id: "files-tab",
        displayName: "Files",
        exportName: "FilesTab",
        entityTypes: ["project"],
        order: 10,
      },
    ],
  },
};

export default manifest;
```

UI launcher component:

```tsx
import type { PluginProjectSidebarItemProps } from "@paperclipai/plugin-sdk/ui";

const PLUGIN_KEY = "acme.file-tools";
const TAB_ID = "files-tab";

export function FilesLauncher({ context }: PluginProjectSidebarItemProps) {
  const prefix = context.companyPrefix ? `/${context.companyPrefix}` : "";
  const href = `${prefix}/projects/${context.entityId}?tab=${encodeURIComponent(
    `plugin:${PLUGIN_KEY}:${TAB_ID}`,
  )}`;

  return (
    <a
      href={href}
      className="block px-3 py-1 text-[12px] text-muted-foreground hover:text-foreground"
    >
      Files
    </a>
  );
}
```

This pattern matches the current host behavior:

- the launcher stays compact and low-risk
- the primary workflow lives in a deep-linkable detail tab
- the operator can bookmark or share the resulting URL

### Modal Example: Plugin-Owned Overlay From A Supported Surface

Paperclip does not provide a `modal` slot type. If your plugin needs a modal, open it from a supported launcher surface such as a toolbar button, settings page, or detail tab, and keep the interaction short-lived.

Example toolbar launcher that opens a plugin-owned modal:

```tsx
import { useState } from "react";
import { ErrorBoundary, Spinner, useHostContext, usePluginAction } from "@paperclipai/plugin-sdk/ui";

export function SyncToolbarButton() {
  const context = useHostContext();
  const triggerSync = usePluginAction("sync-project");
  const [open, setOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleConfirm() {
    if (!context.projectId) return;
    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      await triggerSync({ projectId: context.projectId });
      setOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Sync failed";
      setErrorMessage(message);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <ErrorBoundary>
      <button type="button" className="rounded border px-2 py-1 text-sm" onClick={() => setOpen(true)}>
        Sync
      </button>

      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="acme-sync-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !isSubmitting && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-background p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="acme-sync-title" className="text-base font-semibold">
              Sync this project?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This queues a plugin worker action for project <code>{context.projectId}</code>.
            </p>
            {errorMessage ? <p className="mt-2 text-sm text-destructive">{errorMessage}</p> : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" className="rounded border px-3 py-1.5 text-sm" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground"
                onClick={() => void handleConfirm()}
                disabled={isSubmitting}
              >
                {isSubmitting ? <Spinner size="sm" /> : "Run sync"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ErrorBoundary>
  );
}
```

Manifest entry for that launcher:

```json
{
  "capabilities": ["ui.action.register"],
  "ui": {
    "slots": [
      {
        "type": "toolbarButton",
        "id": "sync-toolbar-button",
        "displayName": "Sync",
        "exportName": "SyncToolbarButton"
      }
    ]
  }
}
```

Modal authoring rules for V1:

- prefer tabs or settings pages for primary workflows; use modals for confirmation, pickers, and compact editors
- manage modal open/close state entirely inside your component
- use `useHostContext()` to derive company, project, and entity scope instead of reading host internals
- implement escape handling, backdrop click behavior, and focus management so the overlay does not fight the host shell

### Bridge Hooks

Communication between UI components and the worker goes through three hooks:

#### `usePluginData<T>(key, params?)`

Fetches data from a `ctx.data.register(key, ...)` handler in the worker.

```tsx
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

const { data, loading, error, refresh } = usePluginData<{ lastSync: string }>(
  "sync-health",
  { companyId: context.companyId },
);

// Re-fetch after an action:
const resync = usePluginAction("resync");
async function handleResync() {
  await resync({ companyId: context.companyId });
  refresh(); // trigger a data re-fetch
}
```

Returns `{ data: T | null, loading: boolean, error: PluginBridgeError | null, refresh: () => void }`.

#### `usePluginAction(key)`

Returns an async function that calls a `ctx.actions.register(key, ...)` handler.

```tsx
const resync = usePluginAction("resync");

try {
  await resync({ companyId: context.companyId });
} catch (err) {
  // err is a PluginBridgeError
  console.error((err as PluginBridgeError).code, (err as PluginBridgeError).message);
}
```

#### `useHostContext()`

Returns the active host context: which company, project, entity, and user is currently visible.

```tsx
const { companyId, projectId, entityId, entityType, userId } = useHostContext();
```

### Shared Components

Shared components from `@paperclipai/plugin-sdk/ui` match the Paperclip design system and are provided by the host at runtime.

```tsx
import {
  MetricCard,
  StatusBadge,
  DataTable,
  Spinner,
  ErrorBoundary,
} from "@paperclipai/plugin-sdk/ui";

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData<SyncStats>("sync-stats", {
    companyId: context.companyId,
  });

  if (loading) return <Spinner />;
  if (error) return <StatusBadge label={error.message} status="error" />;

  return (
    <ErrorBoundary>
      <MetricCard
        label="Synced Issues"
        value={data!.syncedCount}
        trend={{ direction: "up", percentage: 12 }}
      />
    </ErrorBoundary>
  );
}
```

Always wrap plugin UI in `<ErrorBoundary>` to prevent render errors from crashing the host page.

---

## Capabilities Reference

Only declare capabilities that your plugin actually uses. The host enforces them at runtime — calling an API without the corresponding capability throws an error.

Sandbox/runtime enforcement rules:

- Host API calls are checked per operation against your manifest capabilities.
- Bare imports in the worker require explicit host allow-listing and binding.
- Relative imports must stay inside the plugin root directory.
- The worker entrypoint must match the package contract exposed through `package.json#paperclipPlugin` and be directly executable by the host worker runtime.

| Capability | Required for |
|-----------|--------------|
| `companies.read` | Reading company data |
| `projects.read` | Reading project data |
| `project.workspaces.read` | Reading workspace paths |
| `issues.read` | Reading issue data |
| `issue.comments.read` | Reading issue comments |
| `agents.read` | Reading agent data |
| `goals.read` | Reading goal data |
| `activity.read` | Reading activity log |
| `costs.read` | Reading cost data |
| `issues.create` | Creating issues |
| `issues.update` | Updating issues |
| `issue.comments.create` | Creating issue comments |
| `assets.write` | Uploading assets |
| `assets.read` | Reading asset URLs |
| `activity.log.write` | Writing activity log entries |
| `metrics.write` | Writing plugin metrics |
| `plugin.state.read` | `ctx.state.get()` |
| `plugin.state.write` | `ctx.state.set()`, `ctx.state.delete()` |
| `events.subscribe` | `ctx.events.on()` |
| `events.emit` | `ctx.events.emit()` |
| `jobs.schedule` | `ctx.jobs.register()` |
| `webhooks.receive` | `onWebhook()` handler |
| `http.outbound` | `ctx.http.fetch()` |
| `secrets.read-ref` | `ctx.secrets.resolve()` |
| `agent.tools.register` | `ctx.tools.register()` |
| `instance.settings.register` | Registering instance settings pages |
| `ui.sidebar.register` | Sidebar slot |
| `ui.page.register` | Page slot |
| `ui.detailTab.register` | Detail tab slot |
| `ui.dashboardWidget.register` | Dashboard widget slot |
| `ui.action.register` | UI action contributions |

---

## Testing

### Test Harness (`@paperclipai/plugin-sdk/testing`)

The SDK includes an in-memory host harness for unit/integration tests:

```ts
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

const harness = createTestHarness({ manifest });
await plugin.definition.setup(harness.ctx);

await harness.emit("issue.created", { issueId: "iss_1" }, { entityId: "iss_1", entityType: "issue" });
const data = await harness.getData("sync-health", { companyId: "comp_1" });
```

`createTestHarness()` supports:

- synthetic event delivery (`emit`)
- scheduled job execution (`runJob`)
- UI bridge simulation (`getData`, `performAction`)
- agent tool simulation (`executeTool`)
- in-memory state/entity stores and captured logs/metrics/activity

### Unit Testing the Worker

Mock `PluginContext` using `vi.fn()` stubs and call `plugin.definition.setup(mockCtx)`:

```ts
import { describe, it, expect, vi } from "vitest";
import { definePlugin } from "@paperclipai/plugin-sdk";

function buildMockContext() {
  return {
    config: { get: vi.fn().mockResolvedValue({ apiKeyRef: "MY_KEY" }) },
    events: { on: vi.fn(), emit: vi.fn().mockResolvedValue(undefined) },
    jobs: { register: vi.fn() },
    secrets: { resolve: vi.fn().mockResolvedValue("test-api-key") },
    state: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    activity: { log: vi.fn().mockResolvedValue(undefined) },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    tools: { register: vi.fn() },
    metrics: { write: vi.fn().mockResolvedValue(undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    // ... other clients
  };
}

describe("MyPlugin", () => {
  it("registers the full-sync job handler on setup", async () => {
    const ctx = buildMockContext();
    const plugin = await import("../src/worker.ts");
    await plugin.default.definition.setup(ctx as any);

    expect(ctx.jobs.register).toHaveBeenCalledWith("full-sync", expect.any(Function));
  });
});
```

### Validating the Manifest

```ts
import { pluginManifestV1Schema } from "@paperclipai/shared";
import manifest from "../src/manifest.js";

it("manifest is valid", () => {
  const result = pluginManifestV1Schema.safeParse(manifest);
  expect(result.success).toBe(true);
});
```

---

## Common Patterns

### Deduplicating events with idempotency keys

```ts
ctx.events.on("issue.created", async (event) => {
  // Check if we already processed this event
  const processed = await ctx.state.get({
    scopeKind: "issue",
    scopeId: event.entityId!,
    stateKey: "synced-to-linear",
  });
  if (processed) return;

  await syncIssueToLinear(event.entityId!);

  await ctx.state.set(
    { scopeKind: "issue", scopeId: event.entityId!, stateKey: "synced-to-linear" },
    true,
  );
});
```

### Batching with state

```ts
ctx.events.on("issue.created", async (event) => {
  // Append to a pending batch
  const batch = (await ctx.state.get({
    scopeKind: "company",
    scopeId: event.payload.companyId as string,
    stateKey: "pending-sync-batch",
  }) as string[] | null) ?? [];

  batch.push(event.entityId!);

  await ctx.state.set(
    { scopeKind: "company", scopeId: event.payload.companyId as string, stateKey: "pending-sync-batch" },
    batch,
  );
});

// The scheduled job processes the batch
ctx.jobs.register("process-batch", async () => {
  // ... read and process the batch, then clear it
});
```

### Plugin-to-plugin events

A plugin can emit events that other plugins subscribe to:

```ts
// Emitter plugin (acme.linear-sync)
await ctx.events.emit("sync-complete", { syncedCount: 42 });
// Full event type becomes: "plugin.acme.linear-sync.sync-complete"

// Subscriber plugin
ctx.events.on("plugin.acme.linear-sync.sync-complete", async (event) => {
  const { syncedCount } = event.payload as { syncedCount: number };
  ctx.logger.info("Linear sync finished", { syncedCount });
});
```

Emitter requires `events.emit`. Subscriber requires `events.subscribe`.

### Graceful shutdown

```ts
let activeRequests = 0;

async function withTracking<T>(fn: () => Promise<T>): Promise<T> {
  activeRequests++;
  try {
    return await fn();
  } finally {
    activeRequests--;
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.events.on("issue.created", async (event) => {
      await withTracking(() => syncIssue(ctx, event.entityId!));
    });
  },

  async onShutdown() {
    // Wait for in-flight work (up to 10 s total before host force-kills)
    const deadline = Date.now() + 8000;
    while (activeRequests > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

---

## Upgrading Plugins

When you release a new version of your plugin, operators can upgrade their instances via the CLI or UI:

```bash
paperclipai plugin upgrade <plugin-id> --version <new-version>
```

### Semantic Versioning

Plugins MUST follow semantic versioning. The host uses the `version` field in your manifest to track updates.

### Capability Changes

If your new version requires **additional capabilities** not present in the previous version:
1. The host transitions the plugin to `upgrade_pending` status.
2. The operator must explicitly approve the new capabilities.
3. Your new worker will not start until approval is granted.

If you **remove or keep the same capabilities**, the host transitions directly to `ready` and restarts your worker with the new code.

### State Migrations

Plugin upgrades do not automatically migrate your `plugin_state` or `plugin_entities`. Your worker is responsible for detecting format changes and migrating its own data on first run after an upgrade.

**Recommended pattern:** Store a schema version in your instance-scoped state:

```ts
const CURRENT_STATE_VERSION = 2;

const plugin = definePlugin({
  async setup(ctx) {
    const version = await ctx.state.get({ scopeKind: "instance", stateKey: "schema-version" });

    if (version !== CURRENT_STATE_VERSION) {
      await migratePluginData(ctx, version as number | null);
      await ctx.state.set({ scopeKind: "instance", stateKey: "schema-version" }, CURRENT_STATE_VERSION);
    }
  }
});

export default plugin;
runWorker(plugin, import.meta.url);
```
