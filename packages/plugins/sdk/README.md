# `@paperclipai/plugin-sdk`

Official TypeScript SDK for Paperclip plugin authors.

- **Worker SDK:** `@paperclipai/plugin-sdk` — `definePlugin`, context, lifecycle
- **UI SDK:** `@paperclipai/plugin-sdk/ui` — React hooks, components, slot props
- **Testing:** `@paperclipai/plugin-sdk/testing` — in-memory host harness
- **Bundlers:** `@paperclipai/plugin-sdk/bundlers` — esbuild/rollup presets
- **Dev server:** `@paperclipai/plugin-sdk/dev-server` — static UI server + SSE reload

Reference: `doc/plugins/PLUGIN_SPEC.md`

## Package surface

| Import | Purpose |
|--------|--------|
| `@paperclipai/plugin-sdk` | Worker entry: `definePlugin`, `runWorker`, context types, protocol helpers |
| `@paperclipai/plugin-sdk/ui` | UI entry: `usePluginData`, `usePluginAction`, `useHostContext`, shared components |
| `@paperclipai/plugin-sdk/ui/hooks` | Hooks only |
| `@paperclipai/plugin-sdk/ui/types` | UI types and slot prop interfaces |
| `@paperclipai/plugin-sdk/ui/components` | `MetricCard`, `StatusBadge`, `Spinner`, `ErrorBoundary`, etc. |
| `@paperclipai/plugin-sdk/testing` | `createTestHarness` for unit/integration tests |
| `@paperclipai/plugin-sdk/bundlers` | `createPluginBundlerPresets` for worker/manifest/ui builds |
| `@paperclipai/plugin-sdk/dev-server` | `startPluginDevServer`, `getUiBuildSnapshot` |
| `@paperclipai/plugin-sdk/protocol` | JSON-RPC protocol types and helpers (advanced) |
| `@paperclipai/plugin-sdk/types` | Worker context and API types (advanced) |

## Manifest entrypoints

In your plugin manifest you declare:

- **`entrypoints.worker`** (required) — Path to the worker bundle (e.g. `dist/worker.js`). The host loads this and calls `setup(ctx)`.
- **`entrypoints.ui`** (required if you use UI) — Path to the UI bundle directory. The host loads components from here for slots and launchers.

## Install

```bash
pnpm add @paperclipai/plugin-sdk
```

## Worker quick start

```ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.events.on("issue.created", async (event) => {
      ctx.logger.info("Issue created", { issueId: event.entityId });
    });

    ctx.data.register("health", async () => ({ status: "ok" }));
    ctx.actions.register("ping", async () => ({ pong: true }));

    ctx.tools.register("calculator", {
      displayName: "Calculator",
      description: "Basic math",
      parametersSchema: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"]
      }
    }, async (params) => {
      const { a, b } = params as { a: number; b: number };
      return { content: `Result: ${a + b}`, data: { result: a + b } };
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

**Note:** `runWorker(plugin, import.meta.url)` must be called so that when the host runs your worker (e.g. `node dist/worker.js`), the RPC host starts and the process stays alive. When the file is imported (e.g. for tests), the main-module check prevents the host from starting.

### Worker lifecycle and context

**Lifecycle (definePlugin):**

| Hook | Purpose |
|------|--------|
| `setup(ctx)` | **Required.** Called once at startup. Register event handlers, jobs, data/actions/tools, etc. |
| `onHealth?()` | Optional. Return `{ status, message?, details? }` for health dashboard. |
| `onConfigChanged?(newConfig)` | Optional. Apply new config without restart; if omitted, host restarts worker. |
| `onShutdown?()` | Optional. Clean up before process exit (limited time window). |
| `onValidateConfig?(config)` | Optional. Return `{ ok, warnings?, errors? }` for settings UI / Test Connection. |
| `onWebhook?(input)` | Optional. Handle `POST /api/plugins/:pluginId/webhooks/:endpointKey`; required if webhooks declared. |

**Context (`ctx`) in setup:** `config`, `events`, `jobs`, `launchers`, `http`, `secrets`, `assets`, `activity`, `state`, `entities`, `projects`, `companies`, `issues`, `agents`, `goals`, `data`, `actions`, `tools`, `metrics`, `logger`, `manifest`. All host APIs are capability-gated; declare capabilities in the manifest.

**Agents:** `ctx.agents.invoke(agentId, companyId, opts)` for one-shot invocation. `ctx.agents.sessions` for two-way chat: `create`, `list`, `sendMessage` (with streaming `onEvent` callback), `close`. See the [Plugin Authoring Guide](../../doc/plugins/PLUGIN_AUTHORING_GUIDE.md#agent-sessions-two-way-chat) for details.

**Jobs:** Declare in `manifest.jobs` with `jobKey`, `displayName`, `schedule` (cron). Register handler with `ctx.jobs.register(jobKey, fn)`. **Webhooks:** Declare in `manifest.webhooks` with `endpointKey`; handle in `onWebhook(input)`. **State:** `ctx.state.get/set/delete(scopeKey)`; scope kinds: `instance`, `company`, `project`, `project_workspace`, `agent`, `issue`, `goal`, `run`.

## Events

Subscribe in `setup` with `ctx.events.on(name, handler)` or `ctx.events.on(name, filter, handler)`. Emit plugin-scoped events with `ctx.events.emit(name, companyId, payload)` (requires `events.emit`).

**Core domain events (subscribe with `events.subscribe`):**

| Event | Typical entity |
|-------|-----------------|
| `company.created`, `company.updated` | company |
| `project.created`, `project.updated` | project |
| `project.workspace_created`, `project.workspace_updated`, `project.workspace_deleted` | project_workspace |
| `issue.created`, `issue.updated`, `issue.comment.created` | issue |
| `agent.created`, `agent.updated`, `agent.status_changed` | agent |
| `agent.run.started`, `agent.run.finished`, `agent.run.failed`, `agent.run.cancelled` | run |
| `goal.created`, `goal.updated` | goal |
| `approval.created`, `approval.decided` | approval |
| `cost_event.created` | cost |
| `activity.logged` | activity |

**Plugin-to-plugin:** Subscribe to `plugin.<pluginId>.<eventName>` (e.g. `plugin.acme.linear.sync-done`). Emit with `ctx.events.emit("sync-done", companyId, payload)`; the host namespaces it automatically.

**Filter (optional):** Pass a second argument to `on()`: `{ projectId?, companyId?, agentId? }` so the host only delivers matching events.

## Scheduled (recurring) jobs

Plugins can declare **scheduled jobs** that the host runs on a cron schedule. Use this for recurring tasks like syncs, digest reports, or cleanup.

1. **Capability:** Add `jobs.schedule` to `manifest.capabilities`.
2. **Declare jobs** in `manifest.jobs`: each entry has `jobKey`, `displayName`, optional `description`, and `schedule` (a 5-field cron expression).
3. **Register a handler** in `setup()` with `ctx.jobs.register(jobKey, async (job) => { ... })`.

**Cron format** (5 fields: minute, hour, day-of-month, month, day-of-week):

| Field        | Values   | Example |
|-------------|----------|---------|
| minute      | 0–59     | `0`, `*/15` |
| hour        | 0–23     | `2`, `*` |
| day of month | 1–31   | `1`, `*` |
| month       | 1–12     | `*` |
| day of week | 0–6 (Sun=0) | `*`, `1-5` |

Examples: `"0 * * * *"` = every hour at minute 0; `"*/5 * * * *"` = every 5 minutes; `"0 2 * * *"` = daily at 2:00.

**Job handler context** (`PluginJobContext`):

| Field        | Type     | Description |
|-------------|----------|-------------|
| `jobKey`    | string   | Matches the manifest declaration. |
| `runId`     | string   | UUID for this run. |
| `trigger`   | `"schedule" \| "manual" \| "retry"` | What caused this run. |
| `scheduledAt` | string | ISO 8601 time when the run was scheduled. |

Runs can be triggered by the **schedule**, **manually** from the UI/API, or as a **retry** (when an operator re-runs a job after a failure). Re-throw from the handler to mark the run as failed; the host records the failure. The host does not automatically retry—operators can trigger another run manually from the UI or API.

Example:

**Manifest** — include `jobs.schedule` and declare the job:

```ts
// In your manifest (e.g. manifest.ts):
const manifest = {
  // ...
  capabilities: ["jobs.schedule", "plugin.state.write"],
  jobs: [
    {
      jobKey: "heartbeat",
      displayName: "Heartbeat",
      description: "Runs every 5 minutes",
      schedule: "*/5 * * * *",
    },
  ],
  // ...
};
```

**Worker** — register the handler in `setup()`:

```ts
ctx.jobs.register("heartbeat", async (job) => {
  ctx.logger.info("Heartbeat run", { runId: job.runId, trigger: job.trigger });
  await ctx.state.set({ scopeKind: "instance", stateKey: "last-heartbeat" }, new Date().toISOString());
});
```

## UI slots and launchers

Slots are mount points for plugin React components. Launchers are host-rendered entry points (buttons, menu items) that open plugin UI. Declare slots in `manifest.ui.slots` with `type`, `id`, `displayName`, `exportName`; for context-sensitive slots add `entityTypes`. Declare launchers in `manifest.ui.launchers` (or legacy `manifest.launchers`).

### Slot types / launcher placement zones

The same set of values is used as **slot types** (where a component mounts) and **launcher placement zones** (where a launcher can appear). Hierarchy:

| Slot type / placement zone | Scope | Entity types (when context-sensitive) |
|----------------------------|-------|---------------------------------------|
| `page` | Global | — |
| `sidebar` | Global | — |
| `sidebarPanel` | Global | — |
| `settingsPage` | Global | — |
| `dashboardWidget` | Global | — |
| `detailTab` | Entity | `project`, `issue`, `agent`, `goal`, `run` |
| `taskDetailView` | Entity | (task/issue context) |
| `projectSidebarItem` | Entity | `project` |
| `toolbarButton` | Entity | varies by host surface |
| `contextMenuItem` | Entity | varies by host surface |

**Entity types** (for `entityTypes` on slots): `project` \| `issue` \| `agent` \| `goal` \| `run`. Full list: import `PLUGIN_UI_SLOT_TYPES` and `PLUGIN_UI_SLOT_ENTITY_TYPES` from `@paperclipai/plugin-sdk`.

### Launcher actions and render options

| Launcher action | Description |
|-----------------|-------------|
| `navigate` | Navigate to a route (plugin or host). |
| `openModal` | Open a modal. |
| `openDrawer` | Open a drawer. |
| `openPopover` | Open a popover. |
| `performAction` | Run an action (e.g. call plugin). |
| `deepLink` | Deep link to plugin or external URL. |

| Render option | Values | Description |
|---------------|--------|-------------|
| `environment` | `hostInline`, `hostOverlay`, `hostRoute`, `external`, `iframe` | Container the launcher expects after activation. |
| `bounds` | `inline`, `compact`, `default`, `wide`, `full` | Size hint for overlays/drawers. |

### Capabilities

Declare in `manifest.capabilities`. Grouped by scope:

| Scope | Capability |
|-------|------------|
| **Company** | `companies.read` |
| | `projects.read` |
| | `project.workspaces.read` |
| | `issues.read` |
| | `issue.comments.read` |
| | `agents.read` |
| | `goals.read` |
| | `goals.create` |
| | `goals.update` |
| | `activity.read` |
| | `costs.read` |
| | `issues.create` |
| | `issues.update` |
| | `issue.comments.create` |
| | `assets.write` |
| | `assets.read` |
| | `activity.log.write` |
| | `metrics.write` |
| **Instance** | `instance.settings.register` |
| | `plugin.state.read` |
| | `plugin.state.write` |
| **Runtime** | `events.subscribe` |
| | `events.emit` |
| | `jobs.schedule` |
| | `webhooks.receive` |
| | `http.outbound` |
| | `secrets.read-ref` |
| **Agent** | `agent.tools.register` |
| | `agents.invoke` |
| | `agent.sessions.create` |
| | `agent.sessions.list` |
| | `agent.sessions.send` |
| | `agent.sessions.close` |
| **UI** | `ui.sidebar.register` |
| | `ui.page.register` |
| | `ui.detailTab.register` |
| | `ui.dashboardWidget.register` |
| | `ui.action.register` |

Full list in code: import `PLUGIN_CAPABILITIES` from `@paperclipai/plugin-sdk`.

## UI quick start

```tsx
import { usePluginData, usePluginAction, MetricCard } from "@paperclipai/plugin-sdk/ui";

export function DashboardWidget() {
  const { data } = usePluginData<{ status: string }>("health");
  const ping = usePluginAction("ping");
  return (
    <div>
      <MetricCard label="Health" value={data?.status ?? "unknown"} />
      <button onClick={() => void ping()}>Ping</button>
    </div>
  );
}
```

## Launcher surfaces and modals

V1 does not provide a dedicated `modal` slot. Plugins can either:

- declare concrete UI mount points in `ui.slots`
- declare host-rendered entry points in `ui.launchers`

Supported launcher placement zones currently mirror the major host surfaces such as `projectSidebarItem`, `toolbarButton`, `detailTab`, `settingsPage`, and `contextMenuItem`. Plugins may still open their own local modal from those entry points when needed.

Declarative launcher example:

```json
{
  "ui": {
    "launchers": [
      {
        "id": "sync-project",
        "displayName": "Sync",
        "placementZone": "toolbarButton",
        "entityTypes": ["project"],
        "action": {
          "type": "openDrawer",
          "target": "sync-project"
        },
        "render": {
          "environment": "hostOverlay",
          "bounds": "wide"
        }
      }
    ]
  }
}
```

The host returns launcher metadata from `GET /api/plugins/ui-contributions` alongside slot declarations.

When a launcher opens a host-owned overlay or page, `useHostContext()`,
`usePluginData()`, and `usePluginAction()` receive the current
`renderEnvironment` through the bridge. Use that to tailor compact modal UI vs.
full-page layouts without adding custom route parsing in the plugin.

## Project sidebar item

Plugins can add a link under each project in the sidebar via the `projectSidebarItem` slot. This is the recommended slot-based launcher pattern for project-scoped workflows because it can deep-link into a richer plugin tab. The component is rendered once per project with that project’s id in `context.entityId`. Declare the slot and capability in your manifest:

```json
{
  "ui": {
    "slots": [
      {
        "type": "projectSidebarItem",
        "id": "files",
        "displayName": "Files",
        "exportName": "FilesLink",
        "entityTypes": ["project"]
      }
    ]
  },
  "capabilities": ["ui.sidebar.register", "ui.detailTab.register"]
}
```

Minimal React component that links to the project’s plugin tab (see project detail tabs in the spec):

```tsx
import type { PluginProjectSidebarItemProps } from "@paperclipai/plugin-sdk/ui";

export function FilesLink({ context }: PluginProjectSidebarItemProps) {
  const projectId = context.entityId;
  const prefix = context.companyPrefix ? `/${context.companyPrefix}` : "";
  const projectRef = projectId; // or resolve from host; entityId is project id
  return (
    <a href={`${prefix}/projects/${projectRef}?tab=plugin:your-plugin:files`}>
      Files
    </a>
  );
}
```

Use optional `order` in the slot to sort among other project sidebar items. See §19.5.1 in the plugin spec and project detail plugin tabs (§19.3) for the full flow.

## Toolbar launcher with a local modal

For short-lived actions, mount a `toolbarButton` and open a plugin-owned modal inside the component. Use `useHostContext()` to scope the action to the current company or project.

```json
{
  "ui": {
    "slots": [
      {
        "type": "toolbarButton",
        "id": "sync-toolbar-button",
        "displayName": "Sync",
        "exportName": "SyncToolbarButton"
      }
    ]
  },
  "capabilities": ["ui.action.register"]
}
```

```tsx
import { useState } from "react";
import {
  ErrorBoundary,
  Spinner,
  useHostContext,
  usePluginAction,
} from "@paperclipai/plugin-sdk/ui";

export function SyncToolbarButton() {
  const context = useHostContext();
  const syncProject = usePluginAction("sync-project");
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function confirm() {
    if (!context.projectId) return;
    setSubmitting(true);
    setErrorMessage(null);
    try {
      await syncProject({ projectId: context.projectId });
      setOpen(false);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ErrorBoundary>
      <button type="button" onClick={() => setOpen(true)}>
        Sync
      </button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !submitting && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-background p-4 shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-base font-semibold">Sync this project?</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Queue a sync for <code>{context.projectId}</code>.
            </p>
            {errorMessage ? (
              <p className="mt-2 text-sm text-destructive">{errorMessage}</p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button" onClick={() => void confirm()} disabled={submitting}>
                {submitting ? <Spinner size="sm" /> : "Run sync"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ErrorBoundary>
  );
}
```

Prefer deep-linkable tabs and pages for primary workflows. Reserve plugin-owned modals for confirmations, pickers, and compact editors.

## Agent sessions (two-way chat)

Plugins can hold multi-turn conversational sessions with agents:

```ts
// Create a session
const session = await ctx.agents.sessions.create(agentId, companyId);

// Send a message and stream the response
await ctx.agents.sessions.sendMessage(session.sessionId, companyId, {
  prompt: "Help me triage this issue",
  onEvent: (event) => {
    if (event.eventType === "chunk") console.log(event.message);
    if (event.eventType === "done") console.log("Stream complete");
  },
});

// List active sessions
const sessions = await ctx.agents.sessions.list(agentId, companyId);

// Close when done
await ctx.agents.sessions.close(session.sessionId, companyId);
```

Requires capabilities: `agent.sessions.create`, `agent.sessions.list`, `agent.sessions.send`, `agent.sessions.close`.

Exported types: `AgentSession`, `AgentSessionEvent`, `AgentSessionSendResult`, `PluginAgentSessionsClient`.

## Testing utilities

```ts
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../src/worker.js";
import manifest from "../src/manifest.js";

const harness = createTestHarness({ manifest });
await plugin.definition.setup(harness.ctx);
await harness.emit("issue.created", { issueId: "iss_1" }, { entityId: "iss_1", entityType: "issue" });
```

## Bundler presets

```ts
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
// presets.esbuild.worker / presets.esbuild.manifest / presets.esbuild.ui
// presets.rollup.worker / presets.rollup.manifest / presets.rollup.ui
```

## Local dev server (hot-reload events)

```bash
paperclip-plugin-dev-server --root . --ui-dir dist/ui --port 4177
```

Or programmatically:

```ts
import { startPluginDevServer } from "@paperclipai/plugin-sdk/dev-server";
const server = await startPluginDevServer({ rootDir: process.cwd() });
```

Dev server endpoints:
- `GET /__paperclip__/health` returns `{ ok, rootDir, uiDir }`
- `GET /__paperclip__/events` streams `reload` SSE events on UI build changes
