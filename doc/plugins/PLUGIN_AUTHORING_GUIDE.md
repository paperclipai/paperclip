# Plugin Authoring Guide

This guide describes the current, implemented way to create a Paperclip plugin in this repo.

It is intentionally narrower than [PLUGIN_SPEC.md](./PLUGIN_SPEC.md). The spec includes future ideas; this guide only covers the alpha surface that exists now.

> **New to plugins?** Start with the short [Local Plugin Development guide](./LOCAL_PLUGIN_DEVELOPMENT.md) — it walks the CLI happy path (`plugin init` → `pnpm dev` → `plugin install <path>`) end to end. Come back here for the full manifest surface, worker capabilities, and UI components.

## Current reality

- Treat plugin workers and plugin UI as trusted code.
- Plugin UI runs as same-origin JavaScript inside the main Paperclip app.
- Worker-side host APIs are capability-gated.
- Plugin UI is not sandboxed by manifest capabilities.
- Plugin database migrations are restricted to a host-derived plugin namespace.
- Plugin-owned JSON API routes must be declared in the manifest and are mounted
  only under `/api/plugins/:pluginId/api/*`.
- The host provides a small shared React component kit through
  `@paperclipai/plugin-sdk/ui`; use it for common Paperclip controls before
  building custom versions.
- `ctx.assets` is not supported in the current runtime.

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
Do this for plugin-owned agents, plugin-owned projects, and recurring automation.
Do not hide long-lived work behind private plugin state when it should be visible
to the board, scoped to a company, audited, budgeted, and assigned like normal
Paperclip work.

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

Managed resources are resolved by stable plugin keys, not hardcoded database
ids. In a worker action or data handler, call `ctx.agents.managed.reconcile()`,
`ctx.projects.managed.reconcile()`, and `ctx.routines.managed.reconcile()` for
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

      return { project, agent, routine };
    });
  },
});
```

Authoring rules:

- Keep keys stable once published. Renaming `agentKey`, `projectKey`, or
  `routineKey` creates a new managed resource from the host's point of view.
- Use managed agents for plugin-provided labor. Use `ctx.agents.invoke()` or
  `ctx.agents.sessions` only after you have a real agent id, either selected by
  the operator or resolved from `ctx.agents.managed`.
- Use managed routines for recurring or externally triggered work that should
  produce tasks. Schedule, webhook, and API triggers are visible routine
  triggers, and each run has the normal Paperclip issue/audit trail.
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
- `sidebarPanel`
- `detailTab`
- `taskDetailView`
- `projectSidebarItem`
- `globalToolbarButton`
- `toolbarButton`
- `contextMenuItem`
- `commentAnnotation`
- `commentContextMenuItem`

## Shared host components

Use shared components from `@paperclipai/plugin-sdk/ui` when the plugin needs a
Paperclip-native control. The host owns the implementation, so plugins inherit
the board's current styling, ordering, recent selections, and dark-mode behavior
without importing `ui/src` internals.

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
