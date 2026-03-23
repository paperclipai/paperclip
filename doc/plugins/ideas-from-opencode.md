# Plugin Ideas From OpenCode

Status: design report, not a V1 commitment

Paperclip V1 explicitly excludes a plugin framework in [doc/SPEC-implementation.md](../SPEC-implementation.md), but the long-horizon spec says the architecture should leave room for extensions. This report studies the `opencode` plugin system and translates the useful patterns into a Paperclip-shaped design.

Assumption for this document: Paperclip is a single-tenant operator-controlled instance. Plugin installation should therefore be global across the instance. "Companies" are still first-class Paperclip objects, but they are organizational records, not tenant-isolation boundaries for plugin trust or installation.

## Executive Summary

`opencode` has a real plugin system already. It is intentionally low-friction:

- plugins are plain JS/TS modules
- they load from local directories and npm packages
- they can hook many runtime events
- they can add custom tools
- they can extend provider auth flows
- they run in-process and can mutate runtime behavior directly

That model works well for a local coding tool. It should not be copied literally into Paperclip.

The main conclusion is:

- Paperclip should copy `opencode`'s typed SDK, deterministic loading, low authoring friction, and clear extension surfaces.
- Paperclip should not copy `opencode`'s trust model, project-local plugin loading, "override by name collision" behavior, or arbitrary in-process mutation hooks for core business logic.
- Paperclip should use multiple extension classes instead of one generic plugin bag:
  - trusted in-process modules for low-level platform concerns like agent adapters, storage providers, secret providers, and possibly run-log backends
  - out-of-process plugins for most third-party integrations like Linear, GitHub Issues, Grafana, Stripe, and schedulers
  - plugin-contributed agent tools (namespaced, not override-by-collision)
  - plugin-shipped React UI loaded into host extension slots via a typed bridge
  - a typed event bus with server-side filtering and plugin-to-plugin events, plus scheduled jobs for automation

If Paperclip does this well, the examples you listed become straightforward:

- file browser / terminal / git workflow / child process tracking become workspace plugins that resolve paths from the host and handle OS operations directly
- Linear / GitHub / Grafana / Stripe become connector plugins
- future knowledge base and accounting features can also fit the same model

## Sources Examined

I cloned `anomalyco/opencode` and reviewed commit:

- `a965a062595403a8e0083e85770315d5dc9628ab`

Primary files reviewed:

- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/plugin/src/index.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/plugin/src/tool.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/opencode/src/plugin/index.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/opencode/src/config/config.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/opencode/src/tool/registry.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/opencode/src/provider/auth.ts`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/web/src/content/docs/plugins.mdx`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/web/src/content/docs/custom-tools.mdx`
- `https://github.com/anomalyco/opencode/blob/a965a062595403a8e0083e85770315d5dc9628ab/packages/web/src/content/docs/ecosystem.mdx`

Relevant Paperclip files reviewed for current extension seams:

- [server/src/adapters/registry.ts](../../server/src/adapters/registry.ts)
- [ui/src/adapters/registry.ts](../../ui/src/adapters/registry.ts)
- [server/src/storage/provider-registry.ts](../../server/src/storage/provider-registry.ts)
- [server/src/secrets/provider-registry.ts](../../server/src/secrets/provider-registry.ts)
- [server/src/services/run-log-store.ts](../../server/src/services/run-log-store.ts)
- [server/src/services/activity-log.ts](../../server/src/services/activity-log.ts)
- [doc/SPEC.md](../SPEC.md)
- [doc/SPEC-implementation.md](../SPEC-implementation.md)

## What OpenCode Actually Implements

## 1. Plugin authoring API

`opencode` exposes a small package, `@opencode-ai/plugin`, with a typed `Plugin` function and a typed `tool()` helper.

Core shape:

- a plugin is an async function that receives a context object
- the plugin returns a `Hooks` object
- hooks are optional
- plugins can also contribute tools and auth providers

The plugin init context includes:

- an SDK client
- current project info
- current directory
- current git worktree
- server URL
- Bun shell access

That is important: `opencode` gives plugins rich runtime power immediately, not a narrow capability API.

## 2. Hook model

The hook set is broad. It includes:

- event subscription
- config-time hook
- message hooks
- model parameter/header hooks
- permission decision hooks
- shell env injection
- tool execution before/after hooks
- tool definition mutation
- compaction prompt customization
- text completion transforms

The implementation pattern is very simple:

- core code constructs an `output` object
- each matching plugin hook runs sequentially
- hooks mutate the `output`
- final mutated output is used by core

This is elegant and easy to extend.

It is also extremely powerful. A plugin can change auth headers, model params, permission answers, tool inputs, tool descriptions, and shell environment.

## 3. Plugin discovery and load order

`opencode` supports two plugin sources:

- local files
- npm packages

Local directories:

- `~/.config/opencode/plugins/`
- `.opencode/plugins/`

Npm plugins:

- listed in config under `plugin: []`

Load order is deterministic and documented:

1. global config
2. project config
3. global plugin directory
4. project plugin directory

Important details:

- config arrays are concatenated rather than replaced
- duplicate plugin names are deduplicated with higher-precedence entries winning
- internal first-party plugins and default plugins are also loaded through the plugin pipeline

This gives `opencode` a real precedence model rather than "whatever loaded last by accident."

## 4. Dependency handling

For local config/plugin directories, `opencode` will:

- ensure a `package.json` exists
- inject `@opencode-ai/plugin`
- run `bun install`

That lets local plugins and local custom tools import dependencies.

This is excellent for local developer ergonomics.

It is not a safe default for an operator-controlled control plane server.

## 5. Error handling

Plugin load failures do not hard-crash the runtime by default.

Instead, `opencode`:

- logs the error
- publishes a session error event
- continues loading other plugins

That is a good operational pattern. One bad plugin should not brick the entire product unless the operator has explicitly configured it as required.

## 6. Tools are a first-class extension point

`opencode` has two ways to add tools:

- export tools directly from a plugin via `hook.tool`
- define local files in `.opencode/tools/` or global tools directories

The tool API is strong:

- tools have descriptions
- tools have Zod schemas
- tool execution gets context like session ID, message ID, directory, and worktree
- tools are merged into the same registry as built-in tools
- tool definitions themselves can be mutated by a `tool.definition` hook

The most aggressive part of the design:

- custom tools can override built-in tools by name

That is very powerful for a local coding assistant.
It is too dangerous for Paperclip core actions.

However, the concept of plugins contributing agent-usable tools is very valuable for Paperclip — as long as plugin tools are namespaced (cannot shadow core tools) and capability-gated.

## 7. Auth is also a plugin surface

`opencode` allows plugins to register auth methods for providers.

A plugin can contribute:

- auth method metadata
- prompt flows
- OAuth flows
- API key flows
- request loaders that adapt provider behavior after auth succeeds

This is a strong pattern worth copying. Integrations often need custom auth UX and token handling.

## 8. Ecosystem evidence

The ecosystem page is the best proof that the model is working in practice.
Community plugins already cover:

- sandbox/workspace systems
- auth providers
- session headers / telemetry
- memory/context features
- scheduling
- notifications
- worktree helpers
- background agents
- monitoring

That validates the main thesis: a simple typed plugin API can create real ecosystem velocity.

## What OpenCode Gets Right

## 1. Separate plugin SDK from host runtime

This is one of the best parts of the design.

- plugin authors code against a clean public package
- host internals can evolve behind the loader
- runtime code and plugin code have a clean contract boundary

Paperclip should absolutely do this.

## 2. Deterministic loading and precedence

`opencode` is explicit about:

- where plugins come from
- how config merges
- what order wins

Paperclip should copy this discipline.

## 3. Low-ceremony authoring

A plugin author does not have to learn a giant framework.

- export async function
- return hooks
- optionally export tools

That simplicity matters.

## 4. Typed tool definitions

The `tool()` helper is excellent:

- typed
- schema-based
- easy to document
- easy for runtime validation

Paperclip should adopt this style for plugin actions, automations, and UI schemas.

## 5. Built-in features and plugins use similar shapes

`opencode` uses the same hook system for internal and external plugin-style behavior in several places.
That reduces special cases.

Paperclip can benefit from that with adapters, secret backends, storage providers, and connector modules.

## 6. Incremental extension, not giant abstraction upfront

`opencode` did not design a giant marketplace platform first.
It added concrete extension points that real features needed.

That is the correct mindset for Paperclip too.

## What Paperclip Should Not Copy Directly

## 1. In-process arbitrary plugin code as the default

`opencode` is basically a local agent runtime, so unsandboxed plugin execution is acceptable for its audience.

Paperclip is a control plane for an operator-managed instance with company objects.
The risk profile is different:

- secrets matter
- approval gates matter
- budgets matter
- mutating actions require auditability

Default third-party plugins should not run with unrestricted in-process access to server memory, DB handles, and secrets.

## 2. Project-local plugin loading

`opencode` has project-local plugin folders because the tool is centered around a codebase.

Paperclip is not project-scoped. It is instance-scoped.
The comparable unit is:

- instance-installed plugin package

Paperclip should not auto-load arbitrary code from a workspace repo like `.paperclip/plugins` or project directories.

## 3. Arbitrary mutation hooks on core business decisions

Hooks like:

- `permission.ask`
- `tool.execute.before`
- `chat.headers`
- `shell.env`

make sense in `opencode`.

For Paperclip, equivalent hooks into:

- approval decisions
- issue checkout semantics
- activity log behavior
- budget enforcement

would be a mistake.

Core invariants should stay in core code, not become hook-rewritable.

## 4. Override-by-name collision

Allowing a plugin to replace a built-in tool by name is useful in a local agent product.

Paperclip should not allow plugins to silently replace:

- core routes
- core mutating actions
- auth behaviors
- permission evaluators
- budget logic
- audit logic

Extension should be additive or explicitly delegated, never accidental shadowing.

## 5. Auto-install and execute from user config

`opencode`'s "install dependencies at startup" flow is ergonomic.
For Paperclip it would be risky because it combines:

- package installation
- code loading
- execution

inside the control-plane server startup path.

Paperclip should require an explicit operator install step.

## Why Paperclip Needs A Different Shape

The products are solving different problems.

| Topic | OpenCode | Paperclip |
|---|---|---|
| Primary unit | local project/worktree | single-tenant operator instance with company objects |
| Trust assumption | local power user on own machine | operator managing one trusted Paperclip instance |
| Failure blast radius | local session/runtime | entire company control plane |
| Extension style | mutate runtime behavior freely | preserve governance and auditability |
| UI model | local app can load local behavior | board UI must stay coherent and safe |
| Security model | host-trusted local plugins | needs capability boundaries and auditability |

That means Paperclip should borrow the good ideas from `opencode` but use a stricter architecture.

## Paperclip Already Has Useful Pre-Plugin Seams

Paperclip has several extension-like seams already:

- server adapter registry: [server/src/adapters/registry.ts](../../server/src/adapters/registry.ts)
- UI adapter registry: [ui/src/adapters/registry.ts](../../ui/src/adapters/registry.ts)
- storage provider registry: [server/src/storage/provider-registry.ts](../../server/src/storage/provider-registry.ts)
- secret provider registry: [server/src/secrets/provider-registry.ts](../../server/src/secrets/provider-registry.ts)
- pluggable run-log store seam: [server/src/services/run-log-store.ts](../../server/src/services/run-log-store.ts)
- activity log and live event emission: [server/src/services/activity-log.ts](../../server/src/services/activity-log.ts)

This is good news.
Paperclip does not need to invent extensibility from scratch.
It needs to unify and harden existing seams.

## Recommended Paperclip Plugin Model

## 1. Use multiple extension classes

Do not create one giant `hooks` object for everything.

Use distinct plugin classes with different trust models.

| Extension class | Examples | Runtime model | Trust level | Why |
|---|---|---|---|---|
| Platform module | agent adapters, storage providers, secret providers, run-log backends | in-process | highly trusted | tight integration, performance, low-level APIs |
| Connector plugin | Linear, GitHub Issues, Grafana, Stripe | out-of-process worker or sidecar | medium | external sync, safer isolation, clearer failure boundary |
| Workspace plugin | file browser, terminal, git workflow, child process/server tracking | out-of-process, direct OS access | medium | resolves workspace paths from host, owns filesystem/git/PTY/process logic directly |
| UI contribution | dashboard widgets, settings forms, company panels | plugin-shipped React bundles in host extension slots via bridge | medium | plugins own their rendering; host controls slot placement and bridge access |
| Automation plugin | alerts, schedulers, sync jobs, webhook processors | out-of-process | medium | event-driven automation is a natural plugin fit |

This split is the most important design recommendation in this report.

## 2. Keep low-level modules separate from third-party plugins

Paperclip already has this pattern implicitly:

- adapters are one thing
- storage providers are another
- secret providers are another

Keep that separation.

I would formalize it like this:

- `module` means trusted code loaded by the host for low-level runtime services
- `plugin` means integration code that talks to Paperclip through a typed plugin protocol and capability model

This avoids trying to force Stripe, a PTY terminal, and a new agent adapter into the same abstraction.

## 3. Prefer event-driven extensions over core-logic mutation

For third-party plugins, the primary API should be:

- subscribe to typed domain events (with optional server-side filtering)
- emit plugin-namespaced events for cross-plugin communication
- read instance state, including company-bound business records when relevant
- register webhooks
- run scheduled jobs
- contribute tools that agents can use during runs
- write plugin-owned state
- add additive UI surfaces
- invoke explicit Paperclip actions through the API

Do not make third-party plugins responsible for:

- deciding whether an approval passes
- intercepting issue checkout semantics
- rewriting activity log behavior
- overriding budget hard-stops

Those are core invariants.

## 4. Plugins ship their own UI

Plugins ship their own React UI as a bundled module inside `dist/ui/`. The host loads plugin components into designated **extension slots** (pages, tabs, widgets, sidebar entries) and provides a **bridge** for the plugin frontend to talk to its own worker backend and to access host context.

**How it works:**

1. The plugin's UI exports named components for each slot it fills (e.g. `DashboardWidget`, `IssueDetailTab`, `SettingsPage`).
2. The host mounts the plugin component into the correct slot, passing a bridge object with hooks like `usePluginData(key, params)` and `usePluginAction(key)`.
3. The plugin component fetches data from its own worker via the bridge and renders it however it wants.
4. The host enforces capability gates through the bridge — if the worker doesn't have a capability, the bridge rejects the call.

**What the host controls:** where plugin components appear, the bridge API, capability enforcement, and shared UI primitives (`@paperclipai/plugin-sdk/ui`) with design tokens and common components.

**What the plugin controls:** how to render its data, what data to fetch, what actions to expose, and whether to use the host's shared components or build entirely custom UI.

First version extension slots:

- dashboard widgets
- settings pages
- detail-page tabs (project, issue, agent, goal, run)
- sidebar entries
- company-context plugin pages

The host SDK ships shared components (MetricCard, DataTable, StatusBadge, LogView, etc.) for visual consistency, but these are optional.

Later, if untrusted third-party plugins become common, the host can move to iframe-based isolation without changing the plugin's source code (the bridge API stays the same).

## 5. Make installation global and keep mappings/config separate

`opencode` is mostly user-level local config.
Paperclip should treat plugin installation as a global instance-level action.

Examples:

- install `@paperclip/plugin-linear` once
- make it available everywhere immediately
- optionally store mappings over Paperclip objects if one company maps to a different Linear team than another

## 6. Use project workspaces as the primary anchor for local tooling

Paperclip already has a concrete workspace model for projects:

- projects expose `workspaces` and `primaryWorkspace`
- the database already has `project_workspaces`
- project routes already support creating, updating, and deleting workspaces
- heartbeat resolution already prefers project workspaces before falling back to task-session or agent-home workspaces

That means local/runtime plugins should generally anchor themselves to projects first, not invent a parallel workspace model.

Practical guidance:

- file browser should browse project workspaces first
- terminal sessions should be launchable from a project workspace
- git should treat the project workspace as the repo root anchor
- dev server and child-process tracking should attach to project workspaces
- issue and agent views can still deep-link into the relevant project workspace context

In other words:

- `project` is the business object
- `project_workspace` is the local runtime anchor
- plugins should build on that instead of creating an unrelated workspace model first

## 7. Let plugins contribute agent tools

`opencode` makes tools a first-class extension point. This is one of the highest-value surfaces for Paperclip too.

A Linear plugin should be able to contribute a `search-linear-issues` tool that agents use during runs. A git plugin should contribute `create-branch` and `get-diff`. A file browser plugin should contribute `read-file` and `list-directory`.

The key constraints:

- plugin tools are namespaced by plugin ID (e.g. `linear:search-issues`) so they cannot shadow core tools
- plugin tools require the `agent.tools.register` capability
- tool execution goes through the same worker RPC boundary as everything else
- tool results appear in run logs

This is a natural fit — the plugin already has the SDK context, the external API credentials, and the domain logic. Wrapping that in a tool definition is minimal additional work for the plugin author.

## 8. Support plugin-to-plugin events

Plugins should be able to emit custom events that other plugins can subscribe to. For example, the git plugin detects a push and emits `plugin.@paperclip/plugin-git.push-detected`. The GitHub Issues plugin subscribes to that event and updates PR links.

This avoids plugins needing to coordinate through shared state or external channels. The host routes plugin events through the same event bus with the same delivery semantics as core events.

Plugin events use a `plugin.<pluginId>.*` namespace so they cannot collide with core events.

## 9. Auto-generate settings UI from config schema

Plugins that declare an `instanceConfigSchema` should get an auto-generated settings form for free. The host renders text inputs, dropdowns, toggles, arrays, and secret-ref pickers directly from the JSON Schema.

For plugins that need richer settings UX, they can declare a `settingsPage` extension slot and ship a custom React component. Both approaches coexist.

This matters because settings forms are boilerplate that every plugin needs. Auto-generating them from the schema that already exists removes a significant chunk of authoring friction.

## 10. Design for graceful shutdown and upgrade

The spec should be explicit about what happens when a plugin worker stops — during upgrades, uninstalls, or instance restarts.

The recommended policy:

- send `shutdown()` with a configurable deadline (default 10 seconds)
- SIGTERM after deadline, SIGKILL after 5 more seconds
- in-flight jobs marked `cancelled`
- in-flight bridge calls return structured errors to the UI

For upgrades specifically: the old worker drains, the new worker starts. If the new version adds capabilities, it enters `upgrade_pending` until the operator approves.

## 11. Define uninstall data lifecycle

When a plugin is uninstalled, its data (`plugin_state`, `plugin_entities`, `plugin_jobs`, etc.) should be retained for a grace period (default 30 days), not immediately deleted. The operator can reinstall within the grace period and recover state, or force-purge via CLI.

This matters because accidental uninstalls should not cause irreversible data loss.

## 12. Invest in plugin observability

Plugin logs via `ctx.logger` should be stored and queryable from the plugin settings page. The host should also capture raw `stdout`/`stderr` from the worker process as fallback.

The plugin health dashboard should show: worker status, uptime, recent logs, job success/failure rates, webhook delivery rates, and resource usage. The host should emit internal events (`plugin.health.degraded`, `plugin.worker.crashed`) that other plugins or dashboards can consume.

This is critical for operators. Without observability, debugging plugin issues requires SSH access and manual log tailing.

## 13. Ship a test harness and starter template

A `@paperclipai/plugin-test-harness` package should provide a mock host with in-memory stores, synthetic event emission, and `getData`/`performAction`/`executeTool` simulation. Plugin authors should be able to write unit tests without a running Paperclip instance.

A `create-paperclip-plugin` CLI should scaffold a working plugin with manifest, worker, UI bundle, test file, and build config.

Low authoring friction was called out as one of `opencode`'s best qualities. The test harness and starter template are how Paperclip achieves the same.

## 14. Support hot plugin lifecycle

Plugin install, uninstall, upgrade, and config changes should take effect without restarting the Paperclip server. This is critical for developer workflow and operator experience.

The out-of-process worker architecture makes this natural:

- **Hot install**: spawn a new worker, register its event subscriptions, job schedules, webhook endpoints, and agent tools in live routing tables, load its UI bundle into the extension slot registry.
- **Hot uninstall**: graceful shutdown of the worker, remove all registrations from routing tables, unmount UI components, start data retention grace period.
- **Hot upgrade**: shut down old worker, start new worker, atomically swap routing table entries, invalidate UI bundle cache so the frontend loads the updated bundle.
- **Hot config change**: write new config to `plugin_config`, notify the running worker via IPC (`configChanged`). The worker applies the change without restarting. If it doesn't handle `configChanged`, the host restarts just that worker.

Frontend cache invalidation uses versioned or content-hashed bundle URLs and a `plugin.ui.updated` event that triggers re-import without a full page reload.

Each worker process is independent — starting, stopping, or replacing one worker never affects any other plugin or the host itself.

## 15. Define SDK versioning and compatibility

`opencode` does not have a formal SDK versioning story because plugins run in-process and are effectively pinned to the current runtime. Paperclip's out-of-process model means plugins may be built against one SDK version and run on a host that has moved forward. This needs explicit rules.

Recommended approach:

- **Single SDK package**: `@paperclipai/plugin-sdk` with subpath exports — root for worker code, `/ui` for frontend code. One dependency, one version, one changelog.
- **SDK major version = API version**: `@paperclipai/plugin-sdk@2.x` targets `apiVersion: 2`. Plugins built with SDK 1.x declare `apiVersion: 1` and continue to work.
- **Host multi-version support**: The host supports at least the current and one previous `apiVersion` simultaneously with separate IPC protocol handlers per version.
- **`sdkVersion` in manifest**: Plugins declare a semver range (e.g. `">=1.4.0 <2.0.0"`). The host validates this at install time.
- **Deprecation timeline**: Previous API versions get at least 6 months of continued support after a new version ships. The host logs deprecation warnings and shows a banner on the plugin settings page.
- **Migration guides**: Each major SDK release ships with a step-by-step migration guide covering every breaking change.
- **UI surface versioned with worker**: Both worker and UI surfaces are in the same package, so they version together. Breaking changes to shared UI components require a major version bump just like worker API changes.
- **Published compatibility matrix**: The host publishes a matrix of supported API versions and SDK ranges, queryable via API.

## A Concrete SDK Shape For Paperclip

An intentionally narrow first pass could look like this:

```ts
import { definePlugin, z } from "@paperclipai/plugin-sdk";

export default definePlugin({
  id: "@paperclip/plugin-linear",
  version: "0.1.0",
  categories: ["connector", "ui"],
  capabilities: [
    "events.subscribe",
    "jobs.schedule",
    "http.outbound",
    "instance.settings.register",
    "ui.dashboardWidget.register",
    "secrets.read-ref",
  ],
  instanceConfigSchema: z.object({
    linearBaseUrl: z.string().url().optional(),
    companyMappings: z.array(
      z.object({
        companyId: z.string(),
        teamId: z.string(),
        apiTokenSecretRef: z.string(),
      }),
    ).default([]),
  }),
  async register(ctx) {
    ctx.jobs.register("linear-pull", { cron: "*/5 * * * *" }, async (job) => {
      // sync Linear issues into plugin-owned state or explicit Paperclip entities
    });

    // subscribe with optional server-side filter
    ctx.events.on("issue.created", { projectId: "proj-1" }, async (event) => {
      // only receives issue.created events for project proj-1
    });

    // subscribe to events from another plugin
    ctx.events.on("plugin.@paperclip/plugin-git.push-detected", async (event) => {
      // react to the git plugin detecting a push
    });

    // contribute a tool that agents can use during runs
    ctx.tools.register("search-linear-issues", {
      displayName: "Search Linear Issues",
      description: "Search for Linear issues by query",
      parametersSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    }, async (params, runCtx) => {
      // search Linear API and return results
      return { content: JSON.stringify(results) };
    });

    // getData is called by the plugin's own UI components via the host bridge
    ctx.data.register("sync-health", async ({ companyId }) => {
      // return typed JSON that the plugin's DashboardWidget component renders
      return { syncedCount: 142, trend: "+12 today", mappings: [...] };
    });

    ctx.actions.register("resync", async ({ companyId }) => {
      // run sync logic
    });
  },
});
```

The plugin's UI bundle (separate from the worker) might look like:

```tsx
// dist/ui/index.tsx
import { usePluginData, usePluginAction, MetricCard, ErrorBoundary } from "@paperclipai/plugin-sdk/ui";

export function DashboardWidget({ context }: PluginWidgetProps) {
  const { data, loading, error } = usePluginData("sync-health", { companyId: context.companyId });
  const resync = usePluginAction("resync");

  if (loading) return <Spinner />;
  if (error) return <div>Plugin error: {error.message} ({error.code})</div>;

  return (
    <ErrorBoundary fallback={<div>Widget failed to render</div>}>
      <MetricCard label="Synced Issues" value={data.syncedCount} trend={data.trend} />
      <button onClick={() => resync({ companyId: context.companyId })}>Resync Now</button>
    </ErrorBoundary>
  );
}
```

The important point is not the exact syntax.
The important point is the contract shape:

- typed manifest
- explicit capabilities
- explicit global config with optional company mappings
- event subscriptions with optional server-side filtering
- plugin-to-plugin events via namespaced event types
- agent tool contributions
- jobs
- plugin-shipped UI that communicates with its worker through the host bridge
- structured error propagation from worker to UI

## Recommended Core Extension Surfaces

## 1. Platform module surfaces

These should stay close to the current registry style.

Candidates:

- `registerAgentAdapter()`
- `registerStorageProvider()`
- `registerSecretProvider()`
- `registerRunLogStore()`

These are trusted platform modules, not casual plugins.

## 2. Connector plugin surfaces

These are the best near-term plugin candidates.

Capabilities:

- subscribe to domain events
- define scheduled sync jobs
- expose plugin-specific API routes under `/api/plugins/:pluginId/...`
- use company secret refs
- write plugin state
- publish dashboard data
- log activity through core APIs

Examples:

- Linear issue sync
- GitHub issue sync
- Grafana dashboard cards
- Stripe MRR / subscription rollups

## 3. Workspace-runtime surfaces

Workspace plugins handle local tooling directly:

- file browser
- terminal
- git workflow
- child process tracking
- local dev server tracking

Plugins resolve workspace paths through host APIs (`ctx.projects` provides workspace metadata including `cwd`, `repoUrl`, etc.) and then operate on the filesystem, spawn processes, shell out to `git`, or open PTY sessions using standard Node APIs or any libraries they choose.

The host does not wrap or proxy these operations. This keeps the core lean — no need to maintain a parallel API surface for every OS-level operation a plugin might need. Plugins own their own implementations.

## Governance And Safety Requirements

Any Paperclip plugin system has to preserve core control-plane invariants from the repo docs.

That means:

- plugin install is global to the instance
- "companies" remain business objects in the API and data model, not tenant boundaries
- approval gates remain core-owned
- budget hard-stops remain core-owned
- mutating actions are activity-logged
- secrets remain ref-based and redacted in logs

I would require the following for every plugin:

## 1. Capability declaration

Every plugin declares a static capability set such as:

- `companies.read`
- `issues.read`
- `issues.write`
- `events.subscribe`
- `events.emit`
- `jobs.schedule`
- `http.outbound`
- `webhooks.receive`
- `assets.read`
- `assets.write`
- `secrets.read-ref`
- `agent.tools.register`
- `plugin.state.read`
- `plugin.state.write`

The board/operator sees this before installation.

## 2. Global installation

A plugin is installed once and becomes available across the instance.
If it needs mappings over specific Paperclip objects, those are plugin data, not enable/disable boundaries.

## 3. Activity logging

Plugin-originated mutations should flow through the same activity log mechanism, with a dedicated `plugin` actor type:

- `actor_type = plugin`
- `actor_id = <plugin-id>` (e.g. `@paperclip/plugin-linear`)

## 4. Health and failure reporting

Each plugin should expose:

- enabled/disabled state
- last successful run
- last error
- recent webhook/job history

One broken plugin must not break the rest of the company.

## 5. Secret handling

Plugins should receive secret refs, not raw secret values in config persistence.
Resolution should go through the existing secret provider abstraction.

## 6. Resource limits

Plugins should have:

- timeout limits
- concurrency limits
- retry policies
- optional per-plugin budgets

This matters especially for sync connectors and workspace plugins.

## Data Model Additions To Consider

I would avoid "arbitrary third-party plugin-defined SQL migrations" in the first version.
That is too much power too early.

The right mental model is:

- reuse core tables when the data is clearly part of Paperclip itself
- use generic extension tables for most plugin-owned state
- only allow plugin-specific tables later, and only for trusted platform modules or a tightly controlled migration workflow

## Recommended Postgres Strategy For Extensions

### 1. Core tables stay core

If a concept is becoming part of Paperclip's actual product model, it should get a normal first-party table.

Examples:

- `project_workspaces` is already a core table because project workspaces are now part of Paperclip itself
- if a future "project git state" becomes a core feature rather than plugin-owned metadata, that should also be a first-party table

### 2. Most plugins should start in generic extension tables

For most plugins, the host should provide a few generic persistence tables and the plugin stores namespaced records there.

This keeps the system manageable:

- simpler migrations
- simpler backup/restore
- simpler portability story
- easier operator review
- fewer chances for plugin schema drift to break the instance

### 3. Scope plugin data to Paperclip objects before adding custom schemas

A lot of plugin data naturally hangs off existing Paperclip objects:

- project workspace plugin state should often scope to `project` or `project_workspace`
- issue sync state should scope to `issue`
- metrics widgets may scope to `company`, `project`, or `goal`
- process tracking may scope to `project_workspace`, `agent`, or `run`

That gives a good default keying model before introducing custom tables.

### 4. Add trusted module migrations later, not arbitrary plugin migrations now

If Paperclip eventually needs extension-owned tables, I would only allow that for:

- trusted first-party packages
- trusted platform modules
- maybe explicitly installed admin-reviewed plugins with pinned versions

I would not let random third-party plugins run free-form schema migrations on startup.

Instead, add a controlled mechanism later if it becomes necessary.

## Suggested baseline extension tables

## 1. `plugins`

Instance-level installation record.

Suggested fields:

- `id`
- `package_name`
- `version`
- `categories`
- `manifest_json`
- `installed_at`
- `status`

## 2. `plugin_config`

Instance-level plugin config.

Suggested fields:

- `id`
- `plugin_id`
- `config_json`
- `created_at`
- `updated_at`
- `last_error`

## 3. `plugin_state`

Generic key/value state for plugins.

Suggested fields:

- `id`
- `plugin_id`
- `scope_kind` (`instance | company | project | project_workspace | agent | issue | goal | run`)
- `scope_id` nullable
- `namespace`
- `state_key`
- `value_json`
- `updated_at`

This is enough for many connectors before allowing custom tables.

Examples:

- Linear external IDs keyed by `issue`
- GitHub sync cursors keyed by `project`
- file browser preferences keyed by `project_workspace`
- git branch metadata keyed by `project_workspace`
- process metadata keyed by `project_workspace` or `run`

## 4. `plugin_jobs`

Scheduled job and run tracking.

Suggested fields:

- `id`
- `plugin_id`
- `scope_kind` nullable
- `scope_id` nullable
- `job_key`
- `status`
- `last_started_at`
- `last_finished_at`
- `last_error`

## 5. `plugin_webhook_deliveries`

If plugins expose webhooks, delivery history is worth storing.

Suggested fields:

- `id`
- `plugin_id`
- `scope_kind` nullable
- `scope_id` nullable
- `endpoint_key`
- `status`
- `received_at`
- `response_code`
- `error`

## 6. Maybe later: `plugin_entities`

If generic plugin state becomes too limiting, add a structured, queryable entity table for connector records before allowing arbitrary plugin migrations.

Suggested fields:

- `id`
- `plugin_id`
- `entity_type`
- `scope_kind`
- `scope_id`
- `external_id`
- `title`
- `status`
- `data_json`
- `updated_at`

This is a useful middle ground:

- much more queryable than opaque key/value state
- still avoids letting every plugin create its own relational schema immediately

## How The Requested Examples Map To This Model

| Use case | Best fit | Host primitives needed | Notes |
|---|---|---|---|
| File browser | workspace plugin | project workspace metadata | plugin owns filesystem ops directly |
| Terminal | workspace plugin | project workspace metadata | plugin spawns PTY sessions directly |
| Git workflow | workspace plugin | project workspace metadata | plugin shells out to git directly |
| Linear issue tracking | connector plugin | jobs, webhooks, secret refs, issue sync API | very strong plugin candidate |
| GitHub issue tracking | connector plugin | jobs, webhooks, secret refs | very strong plugin candidate |
| Grafana metrics | connector plugin + dashboard widget | outbound HTTP | probably read-only first |
| Child process/server tracking | workspace plugin | project workspace metadata | plugin manages processes directly |
| Stripe revenue tracking | connector plugin | secret refs, scheduled sync, company metrics API | strong plugin candidate |

# Plugin Examples

## Workspace File Browser

Package idea: `@paperclip/plugin-workspace-files`

This plugin lets the board inspect project workspaces, agent workspaces, generated artifacts, and issue-related files without dropping to the shell. It is useful for:

- browsing files inside project workspaces
- debugging what an agent changed
- reviewing generated outputs before approval
- attaching files from a workspace to issues
- understanding repo layout for a company
- inspecting agent home workspaces in local-trusted mode

### UX

- Settings page: `/settings/plugins/workspace-files`
- Main page: `/:companyPrefix/plugins/workspace-files`
- Project tab: `/:companyPrefix/projects/:projectId?tab=files`
- Optional issue tab: `/:companyPrefix/issues/:issueId?tab=files`
- Optional agent tab: `/:companyPrefix/agents/:agentId?tab=workspace`

Main screens and interactions:

- Plugin settings:
  - choose whether the plugin defaults to `project.primaryWorkspace`
  - choose which project workspaces are visible
  - choose whether file writes are allowed or read-only
  - choose whether hidden files are visible
- Main explorer page:
  - project picker at the top
  - workspace picker scoped to the selected project's `workspaces`
  - tree view on the left
  - file preview pane on the right
  - search box for filename/path search
  - actions: copy path, download file, attach to issue, open diff
- Project tab:
  - opens directly into the project's primary workspace
  - lets the board switch among all project workspaces
  - shows workspace metadata like `cwd`, `repoUrl`, and `repoRef`
- Issue tab:
  - resolves the issue's project and opens that project's workspace context
  - shows files linked to the issue
  - lets the board pull files from the project workspace into issue attachments
  - shows the path and last modified info for each linked file
- Agent tab:
  - shows the agent's current resolved workspace
  - if the run is attached to a project, links back to the project workspace view
  - lets the board inspect files the agent is currently touching

Core workflows:

- Board opens a project and browses its primary workspace files.
- Board switches from one project workspace to another when a project has multiple checkouts or repo references.
- Board opens an issue, attaches a generated artifact from the file browser, and leaves a review comment.
- Board opens an agent detail page to inspect the exact files behind a failing run.

### Hooks needed

Recommended capabilities and extension points:

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register` for `project`, `issue`, and `agent`
- `projects.read`
- `project.workspaces.read`
- optional `assets.write`
- `activity.log.write`

The plugin resolves workspace paths through `ctx.projects` and handles all filesystem operations (read, write, stat, search, list directory) directly using Node APIs.

Optional event subscriptions:

- `events.subscribe(agent.run.started)`
- `events.subscribe(agent.run.finished)`
- `events.subscribe(issue.attachment.created)`

## Workspace Terminal

Package idea: `@paperclip/plugin-terminal`

This plugin gives the board a controlled terminal UI for project workspaces and agent workspaces. It is useful for:

- debugging stuck runs
- verifying environment state
- running targeted manual commands
- watching long-running commands
- pairing a human operator with an agent workflow

### UX

- Settings page: `/settings/plugins/terminal`
- Main page: `/:companyPrefix/plugins/terminal`
- Project tab: `/:companyPrefix/projects/:projectId?tab=terminal`
- Optional agent tab: `/:companyPrefix/agents/:agentId?tab=terminal`
- Optional run tab: `/:companyPrefix/agents/:agentId/runs/:runId?tab=terminal`

Main screens and interactions:

- Plugin settings:
  - allowed shells and shell policy
  - whether commands are read-only, free-form, or allow-listed
  - whether terminals require an explicit operator confirmation before launch
  - whether new terminal sessions default to the project's primary workspace
- Terminal home page:
  - list of active terminal sessions
  - button to open a new session
  - project picker, then workspace picker from that project's workspaces
  - optional agent association
  - terminal panel with input, resize, and reconnect support
  - controls: interrupt, kill, clear, save transcript
- Project terminal tab:
  - opens a session already scoped to the project's primary workspace
  - lets the board switch among the project's configured workspaces
  - shows recent commands and related process/server state for that project
- Agent terminal tab:
  - opens a session already scoped to the agent's workspace
  - shows recent related runs and commands
- Run terminal tab:
  - lets the board inspect the environment around a specific failed run

Core workflows:

- Board opens a terminal against an agent workspace to reproduce a failing command.
- Board opens a project page and launches a terminal directly in that project's primary workspace.
- Board watches a long-running dev server or test command from the terminal page.
- Board kills or interrupts a runaway process from the same UI.

### Hooks needed

Recommended capabilities and extension points:

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register` for `project`, `agent`, and `run`
- `projects.read`
- `project.workspaces.read`
- `activity.log.write`

The plugin resolves workspace paths through `ctx.projects` and handles PTY session management (open, input, resize, terminate, subscribe) directly using Node PTY libraries.

Optional event subscriptions:

- `events.subscribe(agent.run.started)`
- `events.subscribe(agent.run.failed)`
- `events.subscribe(agent.run.cancelled)`

## Git Workflow

Package idea: `@paperclip/plugin-git`

This plugin adds repo-aware workflow tooling around issues and workspaces. It is useful for:

- branch creation tied to issues
- quick diff review
- commit and worktree visibility
- PR preparation
- treating the project's primary workspace as the canonical repo anchor
- seeing whether an agent's workspace is clean or dirty

### UX

- Settings page: `/settings/plugins/git`
- Main page: `/:companyPrefix/plugins/git`
- Project tab: `/:companyPrefix/projects/:projectId?tab=git`
- Optional issue tab: `/:companyPrefix/issues/:issueId?tab=git`
- Optional agent tab: `/:companyPrefix/agents/:agentId?tab=git`

Main screens and interactions:

- Plugin settings:
  - branch naming template
  - optional remote provider token secret ref
  - whether write actions are enabled or read-only
  - whether the plugin always uses `project.primaryWorkspace` unless a different project workspace is chosen
- Git overview page:
  - project picker and workspace picker
  - current branch
  - ahead/behind status
  - dirty files summary
  - recent commits
  - active worktrees
  - actions: refresh, create branch, create worktree, stage all, commit, open diff
- Project tab:
  - opens in the project's primary workspace
  - shows workspace metadata and repo binding (`cwd`, `repoUrl`, `repoRef`)
  - shows branch, diff, and commit history for that project workspace
- Issue tab:
  - resolves the issue's project and uses that project's workspace context
  - "create branch from issue" action
  - diff view scoped to the project's selected workspace
  - link branch/worktree metadata to the issue
- Agent tab:
  - shows the agent's branch, worktree, and dirty state
  - shows recent commits produced by that agent
  - if the agent is working inside a project workspace, links back to the project git tab

Core workflows:

- Board creates a branch from an issue and ties it to the project's primary workspace.
- Board opens a project page and reviews the diff for that project's workspace without leaving Paperclip.
- Board reviews the diff after a run without leaving Paperclip.
- Board opens a worktree list to understand parallel branches across agents.

### Hooks needed

Recommended capabilities and extension points:

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.detailTab.register` for `project`, `issue`, and `agent`
- `ui.action.register`
- `projects.read`
- `project.workspaces.read`
- optional `agent.tools.register` (e.g. `create-branch`, `get-diff`, `get-status`)
- optional `events.emit` (e.g. `plugin.@paperclip/plugin-git.push-detected`)
- `activity.log.write`

The plugin resolves workspace paths through `ctx.projects` and handles all git operations (status, diff, log, branch create, commit, worktree create, push) directly using git CLI or a git library.

Optional event subscriptions:

- `events.subscribe(issue.created)`
- `events.subscribe(issue.updated)`
- `events.subscribe(agent.run.finished)`

The git plugin can emit `plugin.@paperclip/plugin-git.push-detected` events that other plugins (e.g. GitHub Issues) subscribe to for cross-plugin coordination.

Note: GitHub/GitLab PR creation should likely live in a separate connector plugin rather than overloading the local git plugin.

## Linear Issue Tracking

Package idea: `@paperclip/plugin-linear`

This plugin syncs Paperclip work with Linear. It is useful for:

- importing backlog from Linear
- linking Paperclip issues to Linear issues
- syncing status, comments, and assignees
- mapping company goals/projects to external product planning
- giving board operators a single place to see sync health

### UX

- Settings page: `/settings/plugins/linear`
- Main page: `/:companyPrefix/plugins/linear`
- Dashboard widget: `/:companyPrefix/dashboard`
- Optional issue tab: `/:companyPrefix/issues/:issueId?tab=linear`
- Optional project tab: `/:companyPrefix/projects/:projectId?tab=linear`

Main screens and interactions:

- Plugin settings:
  - Linear API token secret ref
  - workspace/team/project mappings
  - status mapping between Paperclip and Linear
  - sync direction: import only, export only, bidirectional
  - comment sync toggle
- Linear overview page:
  - sync health card
  - recent sync jobs
  - mapped projects and teams
  - unresolved conflicts queue
  - import actions for teams, projects, and issues
- Issue tab:
  - linked Linear issue key and URL
  - sync status and last synced time
  - actions: link existing, create in Linear, resync now, unlink
  - timeline of synced comments/status changes
- Dashboard widget:
  - open sync errors
  - imported vs linked issues count
  - recent webhook/job failures

Core workflows:

- Board enables the plugin, maps a Linear team, and imports a backlog into Paperclip.
- Paperclip issue status changes push to Linear and Linear comments arrive back through webhooks.
- Board resolves mapping conflicts from the plugin page instead of silently drifting state.

### Hooks needed

Recommended capabilities and extension points:

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.dashboardWidget.register`
- `ui.detailTab.register` for `issue` and `project`
- `events.subscribe(issue.created)`
- `events.subscribe(issue.updated)`
- `events.subscribe(issue.comment.created)`
- `events.subscribe(project.updated)`
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- optional `issues.create`
- optional `issues.update`
- optional `issue.comments.create`
- optional `agent.tools.register` (e.g. `search-linear-issues`, `get-linear-issue`)
- `activity.log.write`

Important constraint:

- webhook processing should be idempotent and conflict-aware
- external IDs and sync cursors belong in plugin-owned state, not inline on core issue rows in the first version

## GitHub Issue Tracking

Package idea: `@paperclip/plugin-github-issues`

This plugin syncs Paperclip issues with GitHub Issues and optionally links PRs. It is useful for:

- importing repo backlogs
- mirroring issue status and comments
- linking PRs to Paperclip issues
- tracking cross-repo work from inside one company view
- bridging engineering workflow with Paperclip task governance

### UX

- Settings page: `/settings/plugins/github-issues`
- Main page: `/:companyPrefix/plugins/github-issues`
- Dashboard widget: `/:companyPrefix/dashboard`
- Optional issue tab: `/:companyPrefix/issues/:issueId?tab=github`
- Optional project tab: `/:companyPrefix/projects/:projectId?tab=github`

Main screens and interactions:

- Plugin settings:
  - GitHub App or PAT secret ref
  - org/repo mappings
  - label/status mapping
  - whether PR linking is enabled
  - whether new Paperclip issues should create GitHub issues automatically
- GitHub overview page:
  - repo mapping list
  - sync health and recent webhook events
  - import backlog action
  - queue of unlinked GitHub issues
- Issue tab:
  - linked GitHub issue and optional linked PRs
  - actions: create GitHub issue, link existing issue, unlink, resync
  - comment/status sync timeline
- Dashboard widget:
  - open PRs linked to active Paperclip issues
  - webhook failures
  - sync lag metrics

Core workflows:

- Board imports GitHub Issues for a repo into Paperclip.
- GitHub webhooks update status/comment state in Paperclip.
- A PR is linked back to the Paperclip issue so the board can follow delivery status.

### Hooks needed

Recommended capabilities and extension points:

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.dashboardWidget.register`
- `ui.detailTab.register` for `issue` and `project`
- `events.subscribe(issue.created)`
- `events.subscribe(issue.updated)`
- `events.subscribe(issue.comment.created)`
- `events.subscribe(plugin.@paperclip/plugin-git.push-detected)` (cross-plugin coordination)
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- optional `issues.create`
- optional `issues.update`
- optional `issue.comments.create`
- `activity.log.write`

Important constraint:

- keep "local git state" and "remote GitHub issue state" in separate plugins even if they work together — cross-plugin events handle coordination

## Grafana Metrics

Package idea: `@paperclip/plugin-grafana`

This plugin surfaces external metrics and dashboards inside Paperclip. It is useful for:

- company KPI visibility
- infrastructure/incident monitoring
- showing deploy, traffic, latency, or revenue charts next to work
- creating Paperclip issues from anomalous metrics

### UX

- Settings page: `/settings/plugins/grafana`
- Main page: `/:companyPrefix/plugins/grafana`
- Dashboard widgets: `/:companyPrefix/dashboard`
- Optional goal tab: `/:companyPrefix/goals/:goalId?tab=metrics`

Main screens and interactions:

- Plugin settings:
  - Grafana base URL
  - service account token secret ref
  - dashboard and panel mappings
  - refresh interval
  - optional alert threshold rules
- Dashboard widgets:
  - one or more metric cards on the main dashboard
  - quick trend view and last refresh time
  - link out to Grafana and link in to the full Paperclip plugin page
- Full metrics page:
  - selected dashboard panels embedded or proxied
  - metric selector
  - time range selector
  - "create issue from anomaly" action
- Goal tab:
  - metric cards relevant to a specific goal or project

Core workflows:

- Board sees service degradation or business KPI movement directly on the Paperclip dashboard.
- Board clicks into the full metrics page to inspect the relevant Grafana panels.
- Board creates a Paperclip issue from a threshold breach with a metric snapshot attached.

### Hooks needed

Recommended capabilities and extension points:

- `instance.settings.register`
- `ui.dashboardWidget.register`
- `ui.page.register`
- `ui.detailTab.register` for `goal` or `project`
- `jobs.schedule`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- optional `issues.create`
- optional `assets.write`
- `activity.log.write`

Optional event subscriptions:

- `events.subscribe(goal.created)`
- `events.subscribe(project.updated)`

Important constraint:

- start read-only first
- do not make Grafana alerting logic part of Paperclip core; keep it as additive signal and issue creation

## Child Process / Server Tracking

Package idea: `@paperclip/plugin-runtime-processes`

This plugin tracks long-lived local processes and dev servers started in project workspaces. It is useful for:

- seeing which agent started which local service
- tracking ports, health, and uptime
- restarting failed dev servers
- exposing process state alongside issue and run state
- making local development workflows visible to the board

### UX

- Settings page: `/settings/plugins/runtime-processes`
- Main page: `/:companyPrefix/plugins/runtime-processes`
- Dashboard widget: `/:companyPrefix/dashboard`
- Process detail page: `/:companyPrefix/plugins/runtime-processes/:processId`
- Project tab: `/:companyPrefix/projects/:projectId?tab=processes`
- Optional agent tab: `/:companyPrefix/agents/:agentId?tab=processes`

Main screens and interactions:

- Plugin settings:
  - whether manual process registration is allowed
  - health check behavior
  - whether operators can stop/restart processes
  - log retention preferences
- Process list page:
  - status table with name, command, cwd, owner agent, port, uptime, and health
  - filters for running/exited/crashed processes
  - actions: inspect, stop, restart, tail logs
- Project tab:
  - filters the process list to the project's workspaces
  - shows which workspace each process belongs to
  - groups processes by project workspace
- Process detail page:
  - process metadata
  - live log tail
  - health check history
  - links to associated issue or run
- Agent tab:
  - shows processes started by or assigned to that agent

Core workflows:

- An agent starts a dev server; the plugin detects and tracks it.
- Board opens a project and immediately sees the processes attached to that project's workspace.
- Board sees a crashed process on the dashboard and restarts it from the plugin page.
- Board attaches process logs to an issue when debugging a failure.

### Hooks needed

Recommended capabilities and extension points:

- `instance.settings.register`
- `ui.sidebar.register`
- `ui.page.register`
- `ui.dashboardWidget.register`
- `ui.detailTab.register` for `project` and `agent`
- `projects.read`
- `project.workspaces.read`
- `plugin.state.read`
- `plugin.state.write`
- `activity.log.write`

The plugin resolves workspace paths through `ctx.projects` and handles process management (register, list, terminate, restart, read logs, health probes) directly using Node APIs.

Optional event subscriptions:

- `events.subscribe(agent.run.started)`
- `events.subscribe(agent.run.finished)`

## Stripe Revenue Tracking

Package idea: `@paperclip/plugin-stripe`

This plugin pulls Stripe revenue and subscription data into Paperclip. It is useful for:

- showing MRR and churn next to company goals
- tracking trials, conversions, and failed payments
- letting the board connect revenue movement to ongoing work
- enabling future financial dashboards beyond token costs

### UX

- Settings page: `/settings/plugins/stripe`
- Main page: `/:companyPrefix/plugins/stripe`
- Dashboard widgets: `/:companyPrefix/dashboard`
- Optional company/goal metric tabs if those surfaces exist later

Main screens and interactions:

- Plugin settings:
  - Stripe secret key secret ref
  - account selection if needed
  - metric definitions such as MRR treatment and trial handling
  - sync interval
  - webhook signing secret ref
- Dashboard widgets:
  - MRR card
  - active subscriptions
  - trial-to-paid conversion
  - failed payment alerts
- Stripe overview page:
  - time series charts
  - recent customer/subscription events
  - webhook health
  - sync history
  - action: create issue from billing anomaly

Core workflows:

- Board enables the plugin and connects a Stripe account.
- Webhooks and scheduled reconciliation keep plugin state current.
- Revenue widgets appear on the main dashboard and can be linked to company goals.
- Failed payment spikes or churn events can generate Paperclip issues for follow-up.

### Hooks needed

Recommended capabilities and extension points:

- `instance.settings.register`
- `ui.dashboardWidget.register`
- `ui.page.register`
- `jobs.schedule`
- `webhooks.receive`
- `http.outbound`
- `secrets.read-ref`
- `plugin.state.read`
- `plugin.state.write`
- `metrics.write`
- optional `issues.create`
- `activity.log.write`

Important constraint:

- Stripe data should stay additive to Paperclip core
- it should not leak into core budgeting logic, which is specifically about model/token spend in V1

## Specific Patterns From OpenCode Worth Adopting

## Adopt

- separate SDK package from runtime loader
- deterministic load order and precedence
- very small authoring API
- typed schemas for plugin inputs/config/tools
- tools as a first-class plugin extension point (namespaced, not override-by-collision)
- internal extensions using the same registration shapes as external ones when reasonable
- plugin load errors isolated from host startup when possible
- explicit community-facing plugin docs and example templates
- test harness and starter template for low authoring friction
- hot plugin lifecycle without server restart (enabled by out-of-process workers)
- formal SDK versioning with multi-version host support

## Adapt, not copy

- local path loading
- dependency auto-install
- hook mutation model
- built-in override behavior
- broad runtime context objects

## Avoid

- project-local arbitrary code loading
- implicit trust of npm packages at startup
- plugins overriding core invariants
- unsandboxed in-process execution as the default extension model

## Suggested Rollout Plan

## Phase 0: Harden the seams that already exist

- formalize adapter/storage/secret/run-log registries as "platform modules"
- remove ad-hoc fallback behavior where possible
- document stable registration contracts

## Phase 1: Add connector plugins first

This is the highest-value, lowest-risk plugin category.

Build:

- plugin manifest
- global install/update lifecycle
- global plugin config and optional company-mapping storage
- secret ref access
- typed domain event subscription
- scheduled jobs
- webhook endpoints
- activity logging helpers
- plugin UI bundle loading, host bridge, `@paperclipai/plugin-sdk/ui`
- extension slot mounting for pages, tabs, widgets, sidebar entries
- auto-generated settings form from `instanceConfigSchema`
- bridge error propagation (`PluginBridgeError`)
- plugin-contributed agent tools
- plugin-to-plugin events (`plugin.<pluginId>.*` namespace)
- event filtering (server-side, per-subscription)
- graceful shutdown with configurable deadlines
- plugin logging and health dashboard
- uninstall with data retention grace period
- `@paperclipai/plugin-test-harness` and `create-paperclip-plugin` starter template
- hot plugin lifecycle (install, uninstall, upgrade, config change without server restart)
- SDK versioning with multi-version host support and deprecation policy

This phase would immediately cover:

- Linear
- GitHub
- Grafana
- Stripe
- file browser
- terminal
- git workflow
- child process/server tracking

Workspace plugins do not require additional host APIs — they resolve workspace paths through `ctx.projects` and handle filesystem, git, PTY, and process operations directly.

## Phase 2: Consider richer UI and plugin packaging

Only after Phase 1 is stable:

- iframe-based isolation for untrusted third-party plugin UI bundles
- signed/verified plugin packages
- plugin marketplace
- optional custom plugin storage backends or migrations

## Recommended Architecture Decision

If I had to collapse this report into one architectural decision, it would be:

Paperclip should not implement "an OpenCode-style generic in-process hook system."
Paperclip should implement "a plugin platform with multiple trust tiers":

- trusted platform modules for low-level runtime integration
- typed out-of-process plugins for instance-wide integrations and automation
- plugin-contributed agent tools (namespaced, capability-gated)
- plugin-shipped UI bundles rendered in host extension slots via a typed bridge with structured error propagation
- plugin-to-plugin events for cross-plugin coordination
- auto-generated settings UI from config schema
- core-owned invariants that plugins can observe and act around, but not replace
- plugin observability, graceful lifecycle management, and a test harness for low authoring friction
- hot plugin lifecycle — no server restart for install, uninstall, upgrade, or config changes
- SDK versioning with multi-version host support and clear deprecation policy

That gets the upside of `opencode`'s extensibility without importing the wrong threat model.

## Concrete Next Steps I Would Take In Paperclip

1. Write a short extension architecture RFC that formalizes the distinction between `platform modules` and `plugins`.
2. Introduce a small plugin manifest type in `packages/shared` and a `plugins` install/config section in the instance config.
3. Build a typed domain event bus around existing activity/live-event patterns, with server-side event filtering and a `plugin.*` namespace for cross-plugin events. Keep core invariants non-hookable.
4. Implement plugin MVP: global install/config, secret refs, jobs, webhooks, plugin UI bundles, extension slots, auto-generated settings forms, bridge error propagation.
5. Add agent tool contributions — plugins register namespaced tools that agents can call during runs.
6. Add plugin observability: structured logging via `ctx.logger`, health dashboard, internal health events.
7. Add graceful shutdown policy and uninstall data lifecycle with retention grace period.
8. Ship `@paperclipai/plugin-test-harness` and `create-paperclip-plugin` starter template.
9. Implement hot plugin lifecycle — install, uninstall, upgrade, and config changes without server restart.
10. Define SDK versioning policy — semver, multi-version host support, deprecation timeline, migration guides, published compatibility matrix.
11. Build workspace plugins (file browser, terminal, git, process tracking) that resolve workspace paths from the host and handle OS-level operations directly.
