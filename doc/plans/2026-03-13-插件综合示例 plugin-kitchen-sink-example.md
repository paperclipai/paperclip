# Kitchen Sink Plugin Plan

## Goal

Add a new first-party example plugin, `Kitchen Sink (Example)`, that demonstrates every currently implemented Paperclip plugin API surface in one place.

This plugin is meant to be:

- a living reference implementation for contributors
- a manual test harness for the plugin runtime
- a discoverable demo of what plugins can actually do today

It is not meant to be a polished end-user product plugin.

## Why

The current plugin system has a real API surface, but it is spread across:

- SDK docs
- SDK types
- plugin spec prose
- two example plugins that each show only a narrow slice

That makes it hard to answer basic questions like:

- what can plugins render?
- what can plugin workers actually do?
- which surfaces are real versus aspirational?
- how should a new plugin be structured in this repo?

The kitchen-sink plugin should answer those questions by example.

## Success Criteria

The plugin is successful if a contributor can install it and, without reading the SDK first, discover and exercise the current plugin runtime surface area from inside Paperclip.

Concretely:

- it installs from the bundled examples list
- it exposes at least one demo for every implemented worker API surface
- it exposes at least one demo for every host-mounted UI surface
- it clearly labels local-only / trusted-only demos
- it is safe enough for local development by default
- it doubles as a regression harness for plugin runtime changes

## Constraints

- Keep it instance-installed, not company-installed.
- Treat this as a trusted/local example plugin.
- Do not rely on cloud-safe runtime assumptions.
- Avoid destructive defaults.
- Avoid irreversible mutations unless they are clearly labeled and easy to undo.

## Source Of Truth For This Plan

This plan is based on the currently implemented SDK/types/runtime, not only the long-horizon spec.

Primary references:

- `packages/plugins/sdk/README.md`
- `packages/plugins/sdk/src/types.ts`
- `packages/plugins/sdk/src/ui/types.ts`
- `packages/shared/src/constants.ts`
- `packages/shared/src/types/plugin.ts`

## Current Surface Inventory

### Worker/runtime APIs to demonstrate

These are the concrete `ctx` clients currently exposed by the SDK:

- `ctx.config`
- `ctx.events`
- `ctx.jobs`
- `ctx.launchers`
- `ctx.http`
- `ctx.secrets`
- `ctx.assets`
- `ctx.activity`
- `ctx.state`
- `ctx.entities`
- `ctx.projects`
- `ctx.companies`
- `ctx.issues`
- `ctx.agents`
- `ctx.goals`
- `ctx.data`
- `ctx.actions`
- `ctx.streams`
- `ctx.tools`
- `ctx.metrics`
- `ctx.logger`

### UI surfaces to demonstrate

Surfaces defined in the SDK:

- `page`
- `settingsPage`
- `dashboardWidget`
- `sidebar`
- `sidebarPanel`
- `detailTab`
- `taskDetailView`
- `projectSidebarItem`
- `toolbarButton`
- `contextMenuItem`
- `commentAnnotation`
- `commentContextMenuItem`

### Current host confidence

Confirmed or strongly indicated as mounted in the current app:

- `page`
- `settingsPage`
- `dashboardWidget`
- `detailTab`
- `projectSidebarItem`
- comment surfaces
- launcher infrastructure

Need explicit validation before claiming full demo coverage:

- `sidebar`
- `sidebarPanel`
- `taskDetailView`
- `toolbarButton` as direct slot, distinct from launcher placement
- `contextMenuItem` as direct slot, distinct from comment menu and launcher placement

The implementation should keep a small validation checklist for these before we call the plugin "complete".

## Plugin Concept

The plugin should be named:

- display name: `Kitchen Sink (Example)`
- package: `@paperclipai/plugin-kitchen-sink-example`
- plugin id: `paperclip.kitchen-sink-example` or `paperclip-kitchen-sink-example`

Recommendation: use `paperclip-kitchen-sink-example` to match current in-repo example naming style.

Category mix:

- `ui`
- `automation`
- `workspace`
- `connector`

That is intentionally broad because the point is coverage.

## UX Shape

The plugin should have one main full-page demo console plus smaller satellites on other surfaces.

### 1. Plugin page

Primary route: the plugin `page` surface should be the central dashboard for all demos.

Recommended page sections:

- `Overview`
  - what this plugin demonstrates
  - current capabilities granted
  - current host context
- `UI Surfaces`
  - links explaining where each other surface should appear
- `Data + Actions`
  - buttons and forms for bridge-driven worker demos
- `Events + Streams`
  - emit event
  - watch event log
  - stream demo output
- `Paperclip Domain APIs`
  - companies
  - projects/workspaces
  - issues
  - goals
  - agents
- `Local Workspace + Process`
  - file listing
  - file read/write scratch area
  - child process demo
- `Jobs + Webhooks + Tools`
  - job status
  - webhook URL and recent deliveries
  - declared tools
- `State + Entities + Assets`
  - scoped state editor
  - plugin entity inspector
  - upload/generated asset demo
- `Observability`
  - metrics written
  - activity log samples
  - latest worker logs

### 2. Dashboard widget

A compact widget on the main dashboard should show:

- plugin health
- count of demos exercised
- recent event/stream activity
- shortcut to the full plugin page

### 3. Project sidebar item

Add a `Kitchen Sink` link under each project that deep-links into a project-scoped plugin tab.

### 4. Detail tabs

Use detail tabs to demonstrate entity-context rendering on:

- `project`
- `issue`
- `agent`
- `goal`

Each tab should show:

- the host context it received
- the relevant entity fetch via worker bridge
- one small action scoped to that entity

### 5. Comment surfaces

Use issue comment demos to prove comment-specific extension points:

- `commentAnnotation`
  - render parsed metadata below each comment
  - show comment id, issue id, and a small derived status
- `commentContextMenuItem`
  - add a menu action like `Copy Context To Kitchen Sink`
  - action writes a plugin entity or state record for later inspection

### 6. Settings page

Custom `settingsPage` should be intentionally simple and operational:

- `About`
- `Danger / Trust Model`
- demo toggles
- local process defaults
- workspace scratch-path behavior
- secret reference inputs
- event/job/webhook sample config

This plugin should also keep the generic plugin settings `Status` tab useful by writing health, logs, and metrics.

## Feature Matrix

Each implemented worker API should have a visible demo.

### `ctx.config`

Demo:

- read live config
- show config JSON
- react to config changes without restart where possible

### `ctx.events`

Demos:

- emit a plugin event
- subscribe to plugin events
- subscribe to a core Paperclip event such as `issue.created`
- show recent received events in a timeline

### `ctx.jobs`

Demos:

- one scheduled heartbeat-style demo job
- one manual run button from the UI if host supports manual job trigger
- show last run result and timestamps

### `ctx.launchers`

Demos:

- declare launchers in manifest
- optionally register one runtime launcher from the worker
- show launcher metadata on the plugin page

### `ctx.http`

Demo:

- make a simple outbound GET request to a safe endpoint
- show status code, latency, and JSON result

Recommendation: default to a Paperclip-local endpoint or a stable public echo endpoint to avoid flaky docs.

### `ctx.secrets`

Demo:

- operator enters a secret reference in config
- plugin resolves it on demand
- UI only shows masked result length / success status, never raw secret

### `ctx.assets`

Demos:

- generate a text asset from the UI
- optionally upload a tiny JSON blob or screenshot-like text file
- show returned asset URL

### `ctx.activity`

Demo:

- button to write a plugin activity log entry against current company/entity

### `ctx.state`

Demos:

- instance-scoped state
- company-scoped state
- project-scoped state
- issue-scoped state
- delete/reset controls

Use a small state inspector/editor on the plugin page.

### `ctx.entities`

Demos:

- create plugin-owned sample records
- list/filter them
- show one realistic use case such as "copied comments" or "demo sync records"

### `ctx.projects`

Demos:

- list projects
- list project workspaces
- resolve primary workspace
- resolve workspace for issue

### `ctx.companies`

Demo:

- list companies and show current selected company

### `ctx.issues`

Demos:

- list issues in current company
- create issue
- update issue status/title
- list comments
- create comment

### `ctx.agents`

Demos:

- list agents
- invoke one agent with a test prompt
- pause/resume where safe

Agent mutation controls should be behind an explicit warning.

### `ctx.agents.sessions`

Demos:

- create agent chat session
- send message
- stream events back to the UI
- close session

This is a strong candidate for the best "wow" demo on the plugin page.

### `ctx.goals`

Demos:

- list goals
- create goal
- update status/title

### `ctx.data`

Use throughout the plugin for all read-side bridge demos.

### `ctx.actions`

Use throughout the plugin for all mutation-side bridge demos.

### `ctx.streams`

Demos:

- live event log stream
- token-style stream from an agent session relay
- fake progress stream for a long-running action

### `ctx.tools`

Demos:

- declare 2-3 simple agent tools
- tool 1: echo/diagnostics
- tool 2: project/workspace summary
- tool 3: create issue or write plugin state

The plugin page should list declared tools and show example input payloads.

### `ctx.metrics`

Demo:

- write a sample metric on each major demo action
- surface a small recent metrics table in the plugin page

### `ctx.logger`

Demo:

- every action logs structured entries
- plugin settings `Status` page then doubles as the log viewer

## Local Workspace And Process Demos

The plugin SDK intentionally leaves file/process operations to the plugin itself once it has workspace metadata.

The kitchen-sink plugin should demonstrate that explicitly.

### Workspace demos

- list files from a selected workspace
- read a file
- write to a plugin-owned scratch file
- optionally search files with `rg` if available

### Process demos

- run a short-lived command like `pwd`, `ls`, or `git status`
- stream stdout/stderr back to UI
- show exit code and timing

Important safeguards:

- default commands must be read-only
- no shell interpolation from arbitrary free-form input in v1
- provide a curated command list or a strongly validated command form
- clearly label this area as local-only and trusted-only

## Proposed Manifest Coverage

The plugin should aim to declare:

- `page`
- `settingsPage`
- `dashboardWidget`
- `detailTab` for `project`, `issue`, `agent`, `goal`
- `projectSidebarItem`
- `commentAnnotation`
- `commentContextMenuItem`

Then, after host validation, add if supported:

- `sidebar`
- `sidebarPanel`
- `taskDetailView`
- `toolbarButton`
- `contextMenuItem`

It should also declare one or more `ui.launchers` entries to exercise launcher behavior independently of slot rendering.

## Proposed Package Layout

New package:

- `packages/plugins/examples/plugin-kitchen-sink-example/`

Expected files:

- `package.json`
- `README.md`
- `tsconfig.json`
- `src/index.ts`
- `src/manifest.ts`
- `src/worker.ts`
- `src/ui/index.tsx`
- `src/ui/components/...`
- `src/ui/hooks/...`
- `src/lib/...`
- optional `scripts/build-ui.mjs` if UI bundling needs esbuild

## Proposed Internal Architecture

### Worker modules

Recommended split:

- `src/worker.ts`
  - plugin definition and wiring
- `src/worker/data.ts`
  - `ctx.data.register(...)`
- `src/worker/actions.ts`
  - `ctx.actions.register(...)`
- `src/worker/events.ts`
  - event subscriptions and event log buffer
- `src/worker/jobs.ts`
  - scheduled job handlers
- `src/worker/tools.ts`
  - tool declarations and handlers
- `src/worker/local-runtime.ts`
  - file/process demos
- `src/worker/demo-store.ts`
  - helpers for state/entities/assets/metrics

### UI modules

Recommended split:

- `src/ui/index.tsx`
  - exported slot components
- `src/ui/page/KitchenSinkPage.tsx`
- `src/ui/settings/KitchenSinkSettingsPage.tsx`
- `src/ui/widgets/KitchenSinkDashboardWidget.tsx`
- `src/ui/tabs/ProjectKitchenSinkTab.tsx`
- `src/ui/tabs/IssueKitchenSinkTab.tsx`
- `src/ui/tabs/AgentKitchenSinkTab.tsx`
- `src/ui/tabs/GoalKitchenSinkTab.tsx`
- `src/ui/comments/KitchenSinkCommentAnnotation.tsx`
- `src/ui/comments/KitchenSinkCommentMenuItem.tsx`
- `src/ui/shared/...`

## Configuration Schema

The plugin should have a substantial but understandable `instanceConfigSchema`.

Recommended config fields:

- `enableDangerousDemos`
- `enableWorkspaceDemos`
- `enableProcessDemos`
- `showSidebarEntry`
- `showSidebarPanel`
- `showProjectSidebarItem`
- `showCommentAnnotation`
- `showCommentContextMenuItem`
- `showToolbarLauncher`
- `defaultDemoCompanyId` optional
- `secretRefExample`
- `httpDemoUrl`
- `processAllowedCommands`
- `workspaceScratchSubdir`

Defaults should keep risky behavior off.

## Safety Defaults

Default posture:

- UI and read-only demos on
- mutating domain demos on but explicitly labeled
- process demos off by default
- no arbitrary shell input by default
- no raw secret rendering ever

## Phased Build Plan

### Phase 1: Core plugin skeleton

- scaffold package
- add manifest, worker, UI entrypoints
- add README
- make it appear in bundled examples list

### Phase 2: Core, confirmed UI surfaces

- plugin page
- settings page
- dashboard widget
- project sidebar item
- detail tabs

### Phase 3: Core worker APIs

- config
- state
- entities
- companies/projects/issues/goals
- data/actions
- metrics/logger/activity

### Phase 4: Real-time and automation APIs

- streams
- events
- jobs
- webhooks
- agent sessions
- tools

### Phase 5: Local trusted runtime demos

- workspace file demos
- child process demos
- guarded by config

### Phase 6: Secondary UI surfaces

- comment annotation
- comment context menu item
- launchers

### Phase 7: Validation-only surfaces

Validate whether the current host truly mounts:

- `sidebar`
- `sidebarPanel`
- `taskDetailView`
- direct-slot `toolbarButton`
- direct-slot `contextMenuItem`

If mounted, add demos.
If not mounted, document them as SDK-defined but host-pending.

## Documentation Deliverables

The plugin should ship with a README that includes:

- what it demonstrates
- which surfaces are local-only
- how to install it
- where each UI surface should appear
- a mapping from demo card to SDK API

It should also be referenced from plugin docs as the "reference everything plugin".

## Testing And Verification

Minimum verification:

- package typecheck/build
- install from bundled example list
- page loads
- widget appears
- project tab appears
- comment surfaces render
- settings page loads
- key actions succeed

Recommended manual checklist:

- create issue from plugin
- create goal from plugin
- emit and receive plugin event
- stream action output
- open agent session and receive streamed reply
- upload an asset
- write plugin activity log
- run a safe local process demo

## Open Questions

1. Should the process demo remain curated-command-only in the first pass?
   Recommendation: yes.

2. Should the plugin create throwaway "kitchen sink demo" issues/goals automatically?
   Recommendation: no. Make creation explicit.

3. Should we expose unsupported-but-typed surfaces in the UI even if host mounting is not wired?
   Recommendation: yes, but label them as `SDK-defined / host validation pending`.

4. Should agent mutation demos include pause/resume by default?
   Recommendation: probably yes, but behind a warning block.

5. Should this plugin be treated as a supported regression harness in CI later?
   Recommendation: yes. Long term, this should be the plugin-runtime smoke test package.

## Recommended Next Step

If this plan looks right, the next implementation pass should start by building only:

- package skeleton
- page
- settings page
- dashboard widget
- one project detail tab
- one issue detail tab
- the basic worker/action/data/state/event scaffolding

That is enough to lock the architecture before filling in every demo surface.
