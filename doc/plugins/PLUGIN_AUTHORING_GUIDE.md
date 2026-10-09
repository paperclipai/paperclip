# Plugin Authoring Guide

This guide describes the current, implemented way to create a Paperclip plugin in this repo.

It is intentionally narrower than [PLUGIN_SPEC.md](./PLUGIN_SPEC.md). The spec includes future ideas; this guide only covers the alpha surface that exists now.

> **New to plugins?** Start with the short [Local Plugin Development guide](./LOCAL_PLUGIN_DEVELOPMENT.md) — it walks the CLI happy path (`plugin init` → `pnpm dev` → `plugin install <path>`) end to end. Come back here for the full manifest surface, worker capabilities, and UI components.

## Current reality

- Treat plugin workers and plugin UI as trusted code.
- Plugin UI runs as same-origin JavaScript inside the main Paperclip app.
- Worker-side host APIs are capability-gated.
- Plugin UI is not sandboxed by manifest capabilities.
- External object reference providers are trusted-install only in the MVP.
  Capabilities gate provider detection/resolution and host API calls, but they
  are not a sandbox boundary for untrusted marketplace code.
- Plugin database migrations are restricted to a host-derived plugin namespace.
- Plugin-managed surfaces are first-class records (agents, projects, routines, and
  skills) rather than private plugin-only state.
- Plugin-owned JSON API routes must be declared in the manifest and are mounted
  only under `/api/plugins/:pluginId/api/*`.
- The host provides a small shared React component kit through
  `@paperclipai/plugin-sdk/ui`; use it for common Paperclip controls before
  building custom versions.
- `ctx.assets` is not supported in the current runtime.

## Idle sleep

An enabled worker blocks automatic idle sleep unless it implements
`onIdleDrain(signal): Promise<"none" | "present" | "unknown">`. This is a live
runtime handshake, not a manifest or version exemption. Older SDKs remain
blockers. Manual shutdown keeps its existing behavior.

The host checks the exact owned, expiring task-drain hold. It closes new worker
admission and checks outstanding RPCs in both directions and live terminal
routes. The SDK also counts accepted handlers and notifications until they
actually finish. Caller timeouts do not count as completion. An unconfirmed
write, missing worker, crash, invalid reply, or expired hold prevents sleep.

The hook must return `none` only when plugin-owned timers, sockets, detached
operations, and cleanup are settled and cannot start work until `signal`
aborts. Do not cancel useful work to make a worker idle. Return `present` while
work remains and `unknown` when completion cannot be proved. The SDK closes
ordinary RPC admission while the hook runs and until the matching hold releases
or expires. Release aborts the signal; expiry does so without another request.
Hooks that suspend autonomous work must arrange its safe resumption on abort.

The handshake does not exempt database work. Enabled jobs, deliveries,
schedules, external ingress, and other persisted work still block sleep until
they have their own safe wake contract. An installed plugin without a matching
live worker receipt also blocks sleep.

Daytona currently opts in only before its worker has contacted the provider.
After provider access it remains a blocker for that process lifetime, even if
the visible operation finishes. Its timeout and terminal cleanup paths need
stronger completion receipts before that restriction can be relaxed. Restarting
does not bypass the separate persisted lease and recovery checks.

## Required agent lifecycle work

Use `onAgentLifecycle` for resources that must be ready before an agent works or
removed before termination completes. Declare both `agentLifecycle: true` and
`agents.lifecycle.manage` in the manifest. The host calls the plugin after the
lifecycle command commits. The lifecycle module owns admission, progress, and
retries; a plugin does not need a readiness data handler or a polling job.

```ts
import { definePlugin } from "@paperclipai/plugin-sdk";
import { reconcileResources } from "./resources.js";

export default definePlugin({
  async setup() {},
  async onAgentLifecycle(request) {
    // Provider code must persist revision fences and tolerate repeated calls.
    const complete = await reconcileResources(request);
    return {
      operationId: request.operationId,
      version: request.version,
      status: complete ? "complete" : "pending",
    };
  },
});
```

`reconcileResources` above is plugin-owned provider code, not an SDK function.
Use `companyId` and `agentId` from the request to scope resources.
Request `agents.read` separately if the handler needs `ctx.agents.get`.
Lifecycle authority does not grant agent configuration writes or secret access.

| Phase | Resource action |
| --- | --- |
| `preparing` | Create or reconcile the agent's resources and wait for readiness. |
| `verifying` | Complete any remaining checks after the host tests the saved harness. |
| `pausing` | Stop resources after the host confirms execution has stopped. |
| `resuming` | Start resources and wait for readiness. |
| `terminating` | Stop resources after the host revokes keys and confirms execution has stopped. |
| `cleaning_up` | Remove owned resources and wait until removal completes. |

Return `pending` while an external operation continues. Return `complete` only
when its effect is confirmed; accepting a deletion request is not completion.
Throw on failure. The host records a fixed error without provider error text.
The agent page shows the phase and offers Retry for failed work.

Calls can repeat, including after a timeout or restart. Retain the highest
version per company and agent, reject older requests, and serialize external
effects or clean up late results. The host's revision fence protects its state;
it cannot cancel a provider request that has already left the process.

The host saves required plugin IDs at first selection. Company-disabled plugins
are excluded then. Disabling or removing a selected plugin blocks progress;
restore it to complete the step. Later installations do not backfill existing
agents. The durable event inbox below is separate: acknowledging an event does
not complete required lifecycle work. See [Agent lifecycle](../AGENT-LIFECYCLE.md)
for phase ordering, recovery, and existing-installation limits.

## Durable resource lifecycle inbox

Plugins with `events.subscribe` can read durable, company-scoped resource hooks
through `ctx.events.listLifecycle(companyId, limit?, afterId?)` and acknowledge successful
work with `ctx.events.acknowledgeLifecycle(companyId, eventId)`. Use an existing
plugin job to poll each configured company; the host checks invocation scope and whether
the plugin is ready and enabled for that company. These methods are separate
from the fire-and-forget `ctx.events.on()` bus.
Proactive jobs and timers may read only companies authorized by the plugin's
company configuration. Calls inside a host-issued invocation must match its company.

An event has `id`, `companyId`, `resourceType`, `resourceId`, `action`, and
`createdAt`. Agent actions are `create`, `pause`, `resume`, and `terminate`;
project actions are `create`, `update`, and `archive`. Pending hires produce creation
after approval. Project updates include repository/workspace mutations and restoring
an archived project. Provider cleanup and retention policy belong to the plugin.

Reads return at most one pending event per resource (default 50, maximum 100).
Creation is delivered before other events for that resource, even when its
backfilled ID is newer. Remaining events follow ID order. After acknowledging
an event, a later read exposes its successor. A failed
resource remains pending without blocking other resources; process the rest of
the batch independently. Progress is stored per plugin, survives worker restarts,
and is not a global sequence cursor. The delivery migration seeds existing hired
agents and all projects once, including archived projects. Pending hires require
approval; paused and terminated agents retain their current status intents.
This baseline represents current desired state, not reconstructed history.
The baseline includes archive for existing archived projects and update for restored projects whose
journal still ends at archive. Archiving does not authorize provider cleanup.
After that migration, capture stays forward-only; no later journal backfill runs.

Delivery is at least once: concurrent reads or a crash after a provider operation
can repeat an event. Serialize polling and use stable company/event idempotency
keys, then acknowledge only after successful completion. Load current authorized
agent/project/workspace data before acting; the journal contains no configuration
snapshots, repository credentials, or deletion authority. For offline plugin tests,
seed `lifecycleEvents` with `createTestHarness().seed()`.

Lifecycle polls can page past failed resources using the last returned event id as
`afterId`. Reset `afterId` at the start of every polling sweep: it is a page
cursor, never a persisted high-water mark. This retries failures and includes
transactions that commit later with lower ids.

## External object reference providers

Plugins can contribute provider-neutral object reference detection and status
resolution for URLs and future explicit links. Declare `objectReferences` in the
manifest and add at least `external.objects.detect` and `external.objects.read`.

```ts
objectReferences: [
  {
    providerKey: "mocktracker",
    displayName: "Mock Tracker",
    objectTypes: ["ticket"],
    urlPatterns: ["https://mock.example/tickets/:id"],
  },
],
```

Implement `onDetectExternalObjects()` in the worker to recognize sanitized URL
candidates and return provider-stable identities. Implement
`onResolveExternalObject()` to return normalized board-safe status metadata.
Paperclip owns inline markdown rendering; plugins must not return React, HTML,
or `dangerouslySetInnerHTML` content for inline references.

## Scaffold a plugin

Use the CLI scaffold command:

```bash
paperclipai plugin init @yourscope/plugin-name --output /absolute/path/to/plugin-repos
```

That creates `<output>/plugin-name/` with:

- `src/manifest.ts`
- `src/worker.ts`
- `src/ui/index.tsx`
- `tests/plugin.spec.ts`
- `esbuild.config.mjs`
- `rollup.config.mjs`

Inside this monorepo, the scaffold uses `workspace:*` for `@paperclipai/plugin-sdk`.

Outside this monorepo, the scaffold snapshots `@paperclipai/plugin-sdk` from the local Paperclip checkout into a `.paperclip-sdk/` tarball so you can build and test a plugin without publishing anything to npm first. Pass `--sdk-path /absolute/path/to/paperclip/packages/plugins/sdk` if you have more than one Paperclip checkout.

## Local development workflow

See the short [Local Plugin Development guide](./LOCAL_PLUGIN_DEVELOPMENT.md) for the full happy path (`pnpm dev` → `paperclipai plugin install <absolute-path>` → `paperclipai plugin list`) and reload semantics.

Minimum verification from the generated plugin folder:

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Supported alpha surface

### CreateOS sandbox provider

The in-repo [`@paperclipai/plugin-createos`](../../packages/plugins/sandbox-providers/createos/README.md)
package implements environment lifecycle hooks and incremental managed-process
output and binary workspace transfers using CreateOS's public HTTP API. It does
not advertise interactive login or template capture. Install
the built package by local path; its optional managed-image catalog key is
`createos`. The package README describes configuration and the opt-in live smoke.

### Worker APIs

Worker:

- config
- events
- jobs
- launchers
- http
- secrets
- activity
- state
- database namespace via `ctx.db`
- scoped JSON API routes declared with `apiRoutes`
- entities
- projects, project workspaces, and plugin-managed projects
- companies
- issues, comments, namespaced `plugin:<pluginKey>` origins, blocker relations, checkout assertions, assignment wakeups, and orchestration summaries
- agents, plugin-managed agents, and agent sessions
- plugin-managed routines
- plugin-managed skills
- goals
- data/actions
- streams
- tools
- metrics
- logger

### Plugin database declarations

First-party or otherwise trusted orchestration plugins can declare:

```ts
database: {
  migrationsDir: "migrations",
  coreReadTables: ["issues"],
}
```

Required capabilities are `database.namespace.migrate` and
`database.namespace.read`; add `database.namespace.write` for runtime mutations.
The host derives `ctx.db.namespace`, runs SQL files in filename order before the
worker starts, records checksums in `plugin_migrations`, and rejects changed
already-applied migrations.

Migration SQL may create or alter objects only inside `ctx.db.namespace`. It may
reference whitelisted `public` core tables for foreign keys or read-only views,
but may not mutate/alter/drop/truncate public tables, create extensions,
triggers, untrusted languages, or runtime multi-statement SQL. Runtime
`ctx.db.query()` is restricted to `SELECT`; runtime `ctx.db.execute()` is
restricted to namespace-local `INSERT`, `UPDATE`, and `DELETE`.

### Scoped plugin API routes

Plugins can expose JSON-only routes under their own namespace:

```ts
apiRoutes: [
  {
    routeKey: "initialize",
    method: "POST",
    path: "/issues/:issueId/smoke",
    auth: "board-or-agent",
    capability: "api.routes.register",
    checkoutPolicy: "required-for-agent-in-progress",
    companyResolution: { from: "issue", param: "issueId" },
  },
]
```

The host resolves the plugin, checks that it is ready, enforces
`api.routes.register`, matches the declared method/path, resolves company access,
and applies checkout policy before dispatching to the worker's `onApiRequest`
handler. The worker receives sanitized headers, route params, query, parsed JSON
body, actor context, and company id. Do not use plugin routes to claim core
paths; they always remain under `/api/plugins/:pluginId/api/*`.

## Managed Paperclip resources

Plugins that provide durable Paperclip business objects should declare them in
the manifest and let the host create or relink the actual records per company.
Do this for plugin-owned agents, projects, routines, and skills.
Do not hide long-lived work behind private plugin state when it should be visible
to the board, scoped to a company, audited, budgeted, and assigned like normal
Paperclip work.

Content-oriented plugins, such as LLM Wiki-style ingestion or durable knowledge
systems, should use the same pattern: managed projects for operation issues,
managed agents plus managed skills for LLM work, and managed routines for
ingest, lint, refresh, or maintenance runs.

Use these surfaces:

- Managed agents: declare top-level `agents[]` and require
  `agents.managed`. Use this when the plugin provides a named worker the board
  should see in the org, budget, pause, invoke, and inspect. Managed agents are
  normal Paperclip agents with plugin ownership metadata, not background plugin
  workers.
- Managed projects: declare top-level `projects[]` and require
  `projects.managed`. Use this when the plugin needs a stable company-scoped
  project for its issues, routines, or workspace-oriented UI. Keep plugin work
  in a project instead of scattering generated issues across unrelated projects.
- Managed routines: declare top-level `routines[]` and require
  `routines.managed`. Use this for scheduled, webhook, or manually triggered
  jobs that should create visible Paperclip issues. Prefer managed routines over
  plugin `jobs[]` for recurring business work; plugin jobs are for plugin
  runtime maintenance that does not need a board-visible task trail.
- Managed skills: declare top-level `skills[]` and require `skills.managed`.
  Use this for reusable plugin capabilities that should be surfaced to operators and
  synced into Paperclip managed agents.

Managed resources are resolved by stable plugin keys, not hardcoded database
ids. In a worker action or data handler, call `ctx.agents.managed.reconcile()`,
`ctx.projects.managed.reconcile()`, `ctx.routines.managed.reconcile()`, and
`ctx.skills.managed.reconcile()` for
the current `companyId`. `reconcile()` creates the missing resource, relinks a
recoverable binding, or returns the existing resource. `reset()` reapplies the
manifest defaults when the operator wants to restore the plugin's suggested
configuration.

Declare dependencies between managed resources with refs. A routine can point
at a managed agent through `assigneeRef` and at a managed project through
`projectRef`. Reconcile the referenced agent and project before reconciling the
routine; if a ref is still missing, the routine resolution reports
`missing_refs` instead of guessing.

```ts
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "example.research-plugin",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Research Plugin",
  description: "Creates a managed research agent and scheduled research routine.",
  author: "Example",
  categories: ["automation"],
  capabilities: [
    "agents.managed",
    "projects.managed",
    "routines.managed",
    "skills.managed",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  agents: [
    {
      agentKey: "researcher",
      displayName: "Researcher",
      role: "research",
      title: "Research Agent",
      capabilities: "Runs recurring research briefs for this company.",
      adapterPreference: ["codex_local", "claude_local", "process"],
      instructions: {
        content: "Follow the Paperclip heartbeat and produce concise research briefs.",
      },
    },
  ],
  projects: [
    {
      projectKey: "research",
      displayName: "Research",
      description: "Recurring research work created by the Research Plugin.",
      status: "in_progress",
    },
  ],
  routines: [
    {
      routineKey: "weekly-brief",
      title: "Weekly research brief",
      description: "Create a short research brief for the board.",
      assigneeRef: { resourceKind: "agent", resourceKey: "researcher" },
      projectRef: { resourceKind: "project", resourceKey: "research" },
      priority: "medium",
      triggers: [
        {
          kind: "schedule",
          label: "Monday morning",
          cronExpression: "0 9 * * 1",
          timezone: "America/Chicago",
          enabled: false,
        },
      ],
    },
  ],
  skills: [
    {
      skillKey: "weekly-brief-skills",
      displayName: "Weekly Briefer",
      description: "Reusable skill for the managed research workflow.",
    },
  ],
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "settings",
        displayName: "Research",
        exportName: "SettingsPage",
      },
    ],
  },
};

export default manifest;
```

In the worker, expose a small setup action or settings-page action that
reconciles the resources for the selected company:

```ts
import { definePlugin } from "@paperclipai/plugin-sdk";

export default definePlugin({
  setup(ctx) {
    ctx.actions.register("setup-company", async (params) => {
      const companyId = String(params.companyId ?? "");
      if (!companyId) throw new Error("companyId is required");

      const project = await ctx.projects.managed.reconcile("research", companyId);
      const agent = await ctx.agents.managed.reconcile("researcher", companyId);
      const routine = await ctx.routines.managed.reconcile("weekly-brief", companyId);
      const skill = await ctx.skills.managed.reconcile("weekly-brief-skills", companyId);

      return { project, agent, routine, skill };
    });
  },
});
```

Authoring rules:

- Keep keys stable once published. Renaming `agentKey`, `projectKey`,
  `routineKey`, or `skillKey` creates a new managed resource from the host's
  point of view.
- Use managed agents for plugin-provided labor. Use `ctx.agents.invoke()` or
  `ctx.agents.sessions` only after you have a real agent id, either selected by
  the operator or resolved from `ctx.agents.managed`.
- Use managed routines for recurring or externally triggered work that should
  produce tasks. Schedule, webhook, and API triggers are visible routine
  triggers, and each run has the normal Paperclip issue/audit trail.
- Use managed skills for reusable operator-visible capabilities that are shared
  by managed agents. Reconcile skill declarations by `skillKey` and keep the
  declared skill markdown and files in sync with agent behavior.
- Use managed projects to keep plugin-generated work organized and to give
  project-scoped plugin UI a stable home. For filesystem access inside a
  project, still resolve project workspaces through `ctx.projects`.
- Keep defaults conservative. Managed declarations are suggestions owned by the
  plugin, but the resulting resources are normal Paperclip records that the
  operator can inspect, pause, and adjust.

UI:

- `usePluginData`
- `usePluginAction`
- `usePluginStream`
- `usePluginToast`
- `useHostContext`
- typed slot props from `@paperclipai/plugin-sdk/ui`

Mount surfaces currently wired in the host include:

- `page`
- `settingsPage`
- `dashboardWidget`
- `sidebar`
- `routeSidebar`
- `sidebarPanel`
- `detailTab`
- `taskDetailView`
- `projectSidebarItem`
- `globalToolbarButton`
- `appShellOverlay` (persistent, signed-in application shell)
- `organizationSwitcher` (one React contribution replacing the organization menu)
- `toolbarButton`
- `contextMenuItem`
- `commentAnnotation`
- `commentContextMenuItem`

### `routeSidebar` and the app sidebar

A `routeSidebar` slot gives a plugin page route its own contextual navigation.
It **coexists** with the main app sidebar rather than replacing it: while your
route is active the host collapses the app `<Sidebar/>` to its 64px icon rail
(still hover/peek-able) and renders your sidebar in a second pane, yielding
`[ app rail ][ your sidebar ][ content ]`.

Because the host drives this collapse, a plugin should **not** mount
`RequestCollapsedSidebar` or otherwise try to collapse the app sidebar itself —
doing so is redundant and fights the host. While your route is active the app
rail is forced collapsed (its expand toggle is hidden), overriding any user pin
— a secondary sidebar always collapses the primary. This force never changes the
user's saved expanded/collapsed preference, so the host restores exactly what
the user chose as soon as they navigate away.

## Shared host components

Use shared components from `@paperclipai/plugin-sdk/ui` when the plugin needs a
Paperclip-native control. The host owns the implementation, so plugins inherit
the board's current styling, ordering, recent selections, and dark-mode behavior
without importing `ui/src` internals.

Prefer shared components for common Paperclip UX patterns to reduce drift and
deprecation risk, especially for task/assignment flows and routine or sidebar-like
plugin screens.

Currently exposed components include:

- `MarkdownBlock` and `MarkdownEditor` for rendered and editable markdown.
- `FileTree` for serializable file and directory trees.
- `IssuesList` for a native company-scoped issue table.
- `AssigneePicker` for the same agent/user selector used in the new issue pane.
  Use the controlled `value` format `agent:<id>`, `user:<id>`, or `""`.
- `ProjectPicker` for the same project selector used in the new issue pane.
  Use the controlled project id value, or `""` for no project.
- `ManagedRoutinesList` for plugin-owned routine settings pages.

```tsx
import { AssigneePicker, ProjectPicker } from "@paperclipai/plugin-sdk/ui";

export function PluginAssignmentControls({ companyId }: { companyId: string }) {
  const [assignee, setAssignee] = useState("");
  const [projectId, setProjectId] = useState("");

  return (
    <>
      <AssigneePicker
        companyId={companyId}
        value={assignee}
        onChange={(value) => setAssignee(value)}
      />
      <ProjectPicker
        companyId={companyId}
        value={projectId}
        onChange={setProjectId}
      />
    </>
  );
}
```

## File and path UI

Plugin UI often needs to render a file tree, accept a folder path, or browse a
project workspace. There are three different surfaces for that, and they map to
different trust and data-flow boundaries. Pick the surface that matches the
data the plugin actually has.

### When to use the shared `FileTree`

Use `FileTree` from `@paperclipai/plugin-sdk/ui` whenever the plugin only needs
to render a serializable file/directory list and react to selection or
expand/collapse. The host owns the implementation, so plugin UI inherits the
board's icons, indent, focus ring, and dark-mode styling without importing host
internals.

```tsx
import {
  FileTree,
  type FileTreeNode,
} from "@paperclipai/plugin-sdk/ui";

const nodes: FileTreeNode[] = [
  { name: "AGENTS.md", path: "AGENTS.md", kind: "file", children: [] },
  {
    name: "wiki",
    path: "wiki",
    kind: "dir",
    children: [
      { name: "index.md", path: "wiki/index.md", kind: "file", children: [] },
    ],
  },
];

export function WikiTree() {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["wiki"]));
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <FileTree
      nodes={nodes}
      selectedFile={selected}
      expandedPaths={expanded}
      onSelectFile={(path) => setSelected(path)}
      onToggleDir={(path) =>
        setExpanded((current) => {
          const next = new Set(current);
          next.has(path) ? next.delete(path) : next.add(path);
          return next;
        })
      }
    />
  );
}
```

Good fits:

- LLM Wiki page navigation in `packages/plugins/plugin-llm-wiki` builds a
  `FileTreeNode[]` from worker query results and renders it through `FileTree`.
- The example `plugin-file-browser-example` lazily fetches a directory's
  children through a `loadFileList` action when `onToggleDir` fires, then
  merges the children into the local tree state — letting the shared component
  handle rendering and selection.

Boundary rules:

- Keep the prop surface serializable (`nodes`, `expandedPaths`, `checkedPaths`,
  `fileBadges`, `fileTones`). Do not pass arbitrary render functions across the
  plugin/host boundary in v1; the supported escape hatches are
  `fileBadges` (status pill keyed by path) and `fileTones` (row tone keyed by
  path).
- Do not import the host's `FileTree.tsx` or any `ui/src/*` module. The SDK
  declaration is the only supported import path for plugin UI.
- The shared `FileTree` is for rendering and selection. Plugin-specific editors,
  ingest flows, query forms, and lint runs stay inside the plugin and do not
  belong as `FileTree` props.

### When to declare `localFolders`

When the plugin needs operator-configured filesystem roots — typically for
trusted local plugins like wiki tooling — declare `localFolders[]` on the
manifest and add the `local.folders` capability. The host renders a settings
surface for the operator to set the absolute path, validates the path
server-side (containment, symlinks, required files/directories), and exposes
`ctx.localFolders.readText()` and `ctx.localFolders.writeTextAtomic()` in the
worker.

```ts
export const manifest = {
  capabilities: ["local.folders"],
  localFolders: [
    {
      folderKey: "content-root",
      displayName: "Content root",
      access: "readWrite",
      requiredDirectories: ["sources", "pages"],
      requiredFiles: ["schema.md"],
    },
  ],
};
```

Use this when:

- The data lives outside any project workspace.
- Reads and writes need company-scoped configuration.
- The operator picks the path once in plugin settings and the worker resolves
  files relative to that root.

Do not use `localFolders` to grant the UI direct browser-side access to the
filesystem — there is no such capability. The browser still goes through the
worker via `getData` / `performAction`, and the worker only exposes paths it
chose to expose.

### When to keep worker-mediated project workspace browsing

When the data lives inside an existing project workspace, keep the browsing
flow worker-mediated:

- The worker uses `ctx.projects.listWorkspaces()` to resolve the workspace
  path, then reads its filesystem with normal Node APIs.
- The plugin UI calls a `getData` handler for the root listing and an action
  for lazy children, then renders them through `FileTree`.
- The worker is the only side that touches the disk. The browser receives a
  serializable tree and never sees raw absolute paths it can replay.

The example `plugin-file-browser-example` is the reference for this pattern:
the worker registers `fileList` (data) and `loadFileList` (action) over the
same handler, and the UI uses the action for on-toggle directory loading so the
shared `FileTree` stays the rendering surface.

### Mixing surfaces

A single plugin can use more than one of these. The LLM Wiki uses
`localFolders` for its content root, then renders the resulting page list
through `FileTree`. The file browser example uses `ctx.projects.listWorkspaces`
to pick a workspace and renders its on-disk tree through `FileTree` with lazy
loading. Pick the boundary per data source, not per plugin.

## Company routes

Plugins may declare a `page` slot with `routePath` to own a company route like:

```text
/:companyPrefix/<routePath>
```

Rules:

- `routePath` must be a single lowercase slug
- it cannot collide with reserved host routes
- it cannot duplicate another installed plugin page route

## Publishing guidance

- Use npm packages as the deployment artifact.
- Treat repo-local example installs as a development workflow only.
- Prefer keeping plugin UI self-contained inside the package.
- Do not rely on host design-system components or undocumented app internals.
- GitHub repository installs are not a first-class workflow today. For local development, use a checked-out local path. For production, publish to npm or a private npm-compatible registry.

## Verification before handoff

At minimum:

```bash
pnpm --filter <your-plugin-package> typecheck
pnpm --filter <your-plugin-package> test
pnpm --filter <your-plugin-package> build
```

If you changed host integration too, also run:

```bash
pnpm -r typecheck
pnpm test:run
pnpm build
```

For image-supplied plugins and the persistent shell lifecycle, see
[Distribution plugins](DISTRIBUTION-PLUGINS.md).

### Organization switcher

Declare one `organizationSwitcher` slot with `ui.sidebar.register`. The host
passes `PluginOrganizationSwitcherProps`: current company display data, collapsed
and open state, navigation/logout callbacks, and an icon renderer. Use the host
logout callback; authenticate remote account requests at their owning service.
`currentCompany` describes the host-local company. A distribution plugin must
resolve its external account/organization label itself; the host does not fetch
that portfolio on the plugin's behalf.
The slot props and `useHostContext()` are display context, not proof of identity.
The host reserves the trigger with a neutral placeholder while account, company,
and plugin discovery load. Plugins should reserve the same space while their
external label loads and retain resolved labels during same-account refreshes.
The host resets plugin state on account/company changes and keeps its built-in
menu when no unique contribution exists, discovery fails, the module is missing,
or rendering throws. The slot is a React-only contract; do not use a custom
element export. This replaces only the menu, not company policy or authorization.
