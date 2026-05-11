# Pipeline Engine UI — Design Spec

**Author:** Lior Franko  
**Date:** 2026-05-11  
**Status:** Draft  
**Depends on:** `2026-05-10-pipeline-engine-design.md`

---

## Overview

An n8n-style visual UI for the pipeline-engine plugin that enables creating, editing, and monitoring YAML-defined pipelines through an interactive DAG canvas. The UI lives inside `packages/plugins/pipeline-engine/src/ui/` and renders via the host's plugin slot system across four surfaces: full page, issue detail tab, sidebar link, and dashboard widget.

## Goals

1. **Visual pipeline builder** — drag-and-drop canvas for authoring pipeline DAGs that serialize to the existing YAML format
2. **Execution replay** — click into any run and see per-stage status, output, errors, and timing on the canvas
3. **Run management** — trigger pipelines manually, cancel stuck runs, view history
4. **At-a-glance health** — dashboard widget showing active/stuck/completed run counts

## Non-goals

- Replacing the YAML-based trigger system (label-matching stays)
- Real-time collaborative editing
- Pipeline versioning/diffing UI (future)
- Sub-pipeline materialization UI (backend not yet implemented — `handleCheckpointCompletion` logs "not yet supported")
- Approval gate interactive UI (backend `requires_approval` field exists but is not wired)

---

## Architecture

### Plugin Surface Slots

| Slot type | ID | Route/Entity | Export | Purpose |
|---|---|---|---|---|
| `page` | `pipelines-page` | `/pipelines` | `PipelinesPage` | Pipeline list + visual builder |
| `detailTab` | `pipeline-runs-tab` | entity: `issue` | `PipelineRunsTab` | Run history & stage detail per issue |
| `sidebar` | `pipelines-sidebar` | — | `PipelinesSidebar` | Nav link to pipelines page |
| `dashboardWidget` | `pipeline-health` | — | `PipelineHealthWidget` | Active/stuck/completed metrics |

### File Structure

```
packages/plugins/pipeline-engine/
├── src/
│   ├── ui/
│   │   ├── index.tsx                 # Slot exports
│   │   ├── constants.ts             # DATA_KEYS, ACTION_KEYS, STREAM_CHANNELS
│   │   ├── components/
│   │   │   ├── PipelineCanvas.tsx   # ReactFlow canvas (n8n-style)
│   │   │   ├── StageNode.tsx        # Custom node renderer
│   │   │   ├── StagePalette.tsx     # Left panel: draggable stage types
│   │   │   ├── StageInspector.tsx   # Right panel: config form
│   │   │   ├── PipelineList.tsx     # List/management view
│   │   │   ├── RunReplayCanvas.tsx  # Read-only execution canvas
│   │   │   ├── RunHistory.tsx       # Run list with status badges
│   │   │   └── DashboardWidget.tsx  # Health metrics
│   │   └── hooks/
│   │       └── useAutoLayout.ts     # Dagre-based auto-layout
│   ├── worker.ts                    # (existing, extended with data/action handlers)
│   ├── manifest.ts                  # (existing, extended with UI declarations)
│   └── ...
├── esbuild.ui.config.mjs           # UI bundle build
└── package.json                     # +@xyflow/react, +dagre dependencies
```

---

## Backend Changes

### New Data Handlers (ctx.data.register)

> **Note:** `ctx.data.register` and `ctx.actions.register` are used by the paperclip-dag plugin (confirmed in that codebase). The pipeline-engine worker currently uses only `onApiRequest`. Migrating to data/action handlers aligns with the newer plugin SDK pattern.

| Key | Params | Returns | Source |
|---|---|---|---|
| `list-pipelines` | `{ companyId }` | `Array<{ name, description, trigger, stageCount, yaml }>` | `plugin_state` yaml keys |
| `get-pipeline` | `{ companyId, pipelineName }` | `PipelineDefinition` (parsed YAML) | `plugin_state` |
| `list-runs` | `{ companyId, issueId?, status?, limit? }` | `Array<PipelineRun>` | `pipeline_runs` table (**new query method needed in StateMachine**) |
| `get-run` | `{ runId }` | `{ run: PipelineRun, stages: PipelineStage[], pipelineDef: PipelineDefinition }` | Existing `getRun` + `getRunStages` + `JSON.parse(run.pipelineYaml)` (stored as JSON despite column name) |
| `list-agents` | `{ companyId }` | `Array<{ id, name }>` | `ctx.agents.list()` (same interface as `Dispatcher.agents`) |

### New Action Handlers (ctx.actions.register)

| Key | Params | Effect |
|---|---|---|
| `save-pipeline` | `{ companyId, name, description, trigger, stages, edges, positions }` | Collapse `edges` into `stages[].depends_on`, serialize to YAML, store in `plugin_state` as `yaml:{name}`, store `positions` as `positions:{name}`, update `trigger_labels` config, **reload in-memory `pipelines` array and `TriggerMatcher`** |
| `delete-pipeline` | `{ companyId, pipelineName }` | Remove from `plugin_state`, remove from `trigger_labels`, reload in-memory state |
| `trigger-run` | `{ companyId, pipelineName, issueId }` | Look up pipeline from in-memory `pipelines` array (which includes both config-bootstrapped and UI-saved pipelines), call `materializePipeline()` |
| `cancel-run` | `{ companyId, runId }` | Set run status to `cancelled` (new status, see below), bulk-update all `pending`/`running` stages to `skipped` (**new StateMachine method: `cancelRun`**) |

**New `PipelineRunStatus` value:** Add `"cancelled"` to the union type in `types.ts`. This distinguishes user-initiated cancellation from pipeline failure. The DB column is `TEXT` so no migration needed.

### Stream Channel

| Channel | Event shape | Emitted when |
|---|---|---|
| `run-progress` | `{ runId, stageId, status, error? }` | Stage status changes (running/completed/failed/skipped) |

Emit calls are added to `advancePipeline()`, `handleCommentEvent()`, and `handleStageFailure()`.

> **SDK verification needed:** `ctx.stream.emit()` is used in the paperclip-dag plugin. Confirm it's available in the plugin SDK version used by pipeline-engine. If not available, fall back to polling via `usePluginData` with a short refetch interval.

### Manifest Changes

```typescript
entrypoints: {
  worker: "./dist/worker.js",
  ui: "./dist/ui",
},
capabilities: [
  // ... existing ...
  "ui.page.register",
  "ui.detailTab.register",
  "ui.sidebar.register",
  "ui.dashboardWidget.register",
],
ui: {
  slots: [
    { type: "page", id: "pipelines-page", displayName: "Pipelines", exportName: "PipelinesPage", routePath: "pipelines" },
    { type: "detailTab", id: "pipeline-runs-tab", displayName: "Pipeline Runs", exportName: "PipelineRunsTab", entityTypes: ["issue"] },
    { type: "sidebar", id: "pipelines-sidebar", displayName: "Pipelines", exportName: "PipelinesSidebar" },
    { type: "dashboardWidget", id: "pipeline-health", displayName: "Pipeline Health", exportName: "PipelineHealthWidget" },
  ],
},
```

---

## UI Components

### 1. PipelinesPage (Page Slot)

Two views: **list** and **builder**.

**List view:**
- Table of pipelines: name, description, trigger label, stage count, last modified
- "Create pipeline" CTA button
- Per-row actions: Edit, Delete, Trigger (manual run)
- Empty state with onboarding prompt

**Builder view (n8n-style canvas):**
- Three-panel layout: palette (left, 200px) | canvas (center, flex) | inspector (right, 320px)
- Top toolbar: Back button, pipeline name input, description input, trigger label config, Auto-layout button, Save button
- Dark canvas background with dot grid
- Drag-and-drop from palette to canvas
- Connect stages by dragging from output handle to input handle
- Click stage → inspector shows type-specific config

### 2. StageNode (Canvas Node)

Dimensions: ~200×90px rounded rectangle.

| Stage type | Accent color | Badge | Subtitle |
|---|---|---|---|
| `worker` | `#3b82f6` (blue) | WRK | Agent role name |
| `classifier` | `#f59e0b` (amber) | CLS | Agent role name |
| `parallel_fan_out` | `#06b6d4` (cyan) | FAN | Fan-in strategy |
| `gate` | `#8b5cf6` (purple) | GTE | Condition preview |
| `sub-pipeline` | `#22c55e` (green) | SUB | Referenced pipeline name |

Visual structure:
- Left accent stripe (4px, type color)
- Label (bold, 13px)
- Type badge (top-right, colored pill)
- Subtitle (muted, 11px)
- Top handle (input/target)
- Bottom handle (output/source)

During execution replay, stage border changes:
- `pending` → gray border
- `running` → blue border + pulse animation
- `completed` → green border + checkmark icon
- `failed` → red border + error icon
- `skipped` → dashed gray border

### 3. StagePalette (Left Panel)

Draggable cards for each stage type:
- Worker (assign agent to do work)
- Classifier (agent makes a decision)
- Parallel fan-out (split into parallel branches)
- Gate (conditional checkpoint)
- Sub-pipeline (nest another pipeline)

Each card shows: icon, type name, one-line description. Drag-and-drop via HTML5 drag API (same as paperclip-dag).

### 4. StageInspector (Right Panel)

Context-sensitive form when a node or edge is selected.

**Common fields (all types):**
- Label (text input)
- Type (dropdown, changes node type)
- Depends on (read-only, derived from edges)
- Condition expression (text input)
- Skip-if expression (text input)
- Timeout (duration input)
- Checkpoint toggle

**Worker/Classifier fields:**
- Agent role (dropdown, populated from config's `role_mapping` keys or free text)
- Output schema (file reference input)

**Parallel fan-out fields:**
- Fan-in strategy (dropdown: `all_complete` | `first_complete`)
- Per-task toggle
- Ordering expression

**Gate fields:**
- Requires approval toggle (future)
- Condition expression (prominent)

**Sub-pipeline fields:**
- Pipeline reference (dropdown of existing pipelines)
- Per-task toggle
- Ordering expression

**On-failure section (all types):**
- Retry target stage (dropdown of other stages)
- Retry body template (textarea with Handlebars)
- Max retries (number input)

**Edge inspector (when edge selected):**
- Source → Target (read-only)
- Condition label (text)
- Delete edge button

### 5. RunReplayCanvas (Execution View)

Read-only ReactFlow canvas that renders the pipeline graph from `pipeline_runs.pipeline_yaml` with stage rows overlaid as status colors.

- Same node layout as builder (re-uses StageNode component)
- Nodes get status-colored borders and badges
- Click a stage → inspector shows:
  - Status badge
  - Started at / Completed at / Duration
  - Retry count
  - Output JSON (collapsible tree)
  - Error message (if failed)
  - Link to sub-issue (clickable, navigates to issue)
- Animated flowing dots on edges for `running` stages
- Sub-pipeline stages show "Drill in" button (disabled/placeholder until backend materializes sub-pipelines)

### 6. PipelineRunsTab (Issue Detail Tab)

Shown on issues that have (or had) pipeline runs.

**Sections:**
1. **Trigger section** — buttons to manually trigger available pipelines on this issue
2. **Active runs** — for each running/paused run:
   - Pipeline name, status badge, started time
   - Mini progress indicator (X/Y stages complete)
   - Click to expand → RunReplayCanvas inline or navigate to full view
3. **Run history** — chronological list of past runs:
   - Pipeline name, final status, duration, created at
   - Expandable to show stage timeline

### 7. PipelineHealthWidget (Dashboard Widget)

Three metric cards:
- **Active runs** — count of `running` status runs (blue)
- **Stuck runs** — runs that have been `running` for >1h with no stage progress (red)
- **Completed (24h)** — runs completed in last 24 hours (green)

Below: list of up to 5 recent completions with pipeline name and status.

### 8. PipelinesSidebar (Sidebar Link)

Simple link with DAG icon (same SVG as paperclip-dag) pointing to `/:companyPrefix/pipelines`.

---

## Canvas → YAML Serialization

The builder stores pipelines in the same format the engine already consumes:

```yaml
name: feature-pipeline
description: End-to-end feature development workflow
trigger:
  label: pipeline:feature
stages:
  - id: spec-review
    type: worker
    agent_role: reviewer
    output_schema: schemas/spec-review-output.json
    checkpoint: true
  - id: decomposition
    type: worker
    agent_role: architect
    depends_on: [spec-review]
    output_schema: schemas/decomposition-output.json
  - id: implementation
    type: parallel_fan_out
    agent_role: developer
    depends_on: [decomposition]
    per_task: true
    fan_in: all_complete
  - id: validation
    type: worker
    agent_role: validator
    depends_on: [implementation]
    on_failure:
      retry_with:
        goto: implementation
        body: "Fix: {{output.issues}}"
        max_retries: 2
```

**Serialization logic:**
- Canvas nodes → `stages[]` with `id`, `type`, and type-specific fields
- Canvas edges → collapsed into `depends_on[]` arrays on target nodes (edges are NOT stored separately in YAML)
- Pipeline metadata → top-level `name`, `description`, `trigger`
- Node positions stored in `plugin_state` as `positions:{pipelineName}` with format `Record<string, { x: number; y: number }>` (nodeId → position)
- `description` defaults to `""` if left blank (required field in `PipelineDefinition`)

**Deserialization (load existing):**
- Parse YAML → nodes (one per stage, all top-level — `parallel_fan_out.stages[]` inline children are NOT supported on the canvas; they render as a single fan-out node)
- Build edges from `depends_on` references
- Load positions from `plugin_state` `positions:{name}` key
- Apply dagre auto-layout if no saved positions exist

**Important:** `pipeline_runs.pipeline_yaml` column stores JSON (via `JSON.stringify`), NOT actual YAML. The `get-run` handler must use `JSON.parse()`, not `js-yaml.load()`. The `plugin_state` `yaml:{name}` key stores actual YAML text (via `js-yaml.dump()` during `save-pipeline`).

---

## Dependencies

**New npm packages for pipeline-engine:**
- `@xyflow/react` — ReactFlow canvas
- `dagre` — auto-layout algorithm
- `@types/dagre` — types

**Build:**
- New `esbuild.ui.config.mjs` that bundles `src/ui/index.tsx` to `dist/ui/index.js`
- Externals: `react`, `react-dom`, `@paperclipai/plugin-sdk/ui` (provided by host)

---

## Data Flow Summary

```
┌─────────────────────────────────────────────────────────────┐
│  UI (Plugin Slot)                                            │
│                                                              │
│  usePluginData("list-pipelines")  → worker data handler     │
│  usePluginData("get-run")         → worker data handler     │
│  usePluginAction("save-pipeline") → worker action handler   │
│  usePluginStream("run-progress")  → worker stream emit      │
└──────────────────────────────┬──────────────────────────────┘
                               │ plugin bridge
┌──────────────────────────────▼──────────────────────────────┐
│  Worker (src/worker.ts)                                      │
│                                                              │
│  ctx.data.register("list-pipelines", ...)                   │
│  ctx.actions.register("save-pipeline", ...)                 │
│  ctx.stream.emit("run-progress", ...)                       │
│                                                              │
│  StateMachine ←→ PostgreSQL (pipeline_runs, pipeline_stages)│
│  plugin_state  ←→ YAML definitions                          │
└─────────────────────────────────────────────────────────────┘
```

---

## Testing Strategy

- **Unit tests:** Serialization/deserialization (canvas model ↔ YAML) roundtrip
- **Unit tests:** Data/action handlers with mocked DB
- **Storybook stories:** StageNode in each type + status variant, StagePalette, StageInspector per type
- **Integration scenario:** Create pipeline in UI → verify YAML in plugin_state → trigger run → verify stages advance → verify replay shows correct status

---

## New StateMachine Methods Required

| Method | Signature | Purpose |
|---|---|---|
| `listRuns` | `(companyId, opts?: { issueId?, status?, limit? })` → `PipelineRun[]` | Multi-run listing with filters |
| `cancelRun` | `(runId)` → void | Set run to `cancelled`, bulk-set pending/running stages to `skipped` |

## New PipelineRunStatus Value

Add `"cancelled"` to the `PipelineRunStatus` union type. Update status-color mapping in UI:
- `cancelled` → gray (`#9ca3af`)

## Stuck Run Detection (Dashboard Widget)

"Stuck runs" query: runs with `status = 'running'` where the most recent `pipeline_stages.started_at` is older than 1 hour. This requires a join:
```sql
SELECT r.* FROM pipeline_runs r
WHERE r.status = 'running'
AND r.company_id = $1
AND NOT EXISTS (
  SELECT 1 FROM pipeline_stages s
  WHERE s.pipeline_run_id = r.id
  AND (s.status = 'running' AND s.started_at > NOW() - INTERVAL '1 hour')
)
```

## Resolved Decisions

1. **Node positions** — stored in `plugin_state` as `positions:{pipelineName}`, format: `Record<string, {x: number, y: number}>`. Written on save alongside YAML.
2. **Approval gates** — UI shows gate nodes with a "requires approval" badge but the interactive approve/reject buttons are deferred until the backend implements `requires_approval` handling. Gate conditions are auto-evaluated as today.
3. **Sub-pipeline drill-in** — UI shows sub-pipeline nodes as non-expandable (disabled "Drill in" button) until `handleCheckpointCompletion` implements sub-pipeline materialization.
4. **`parallel_fan_out` inline stages** — NOT represented as nested nodes on the canvas. The fan-out node is a single card; its inline `stages[]` field is not editable in the visual builder (use YAML directly for that advanced case). The canvas only supports the `parallel_fan_out` as a single dispatchable unit with `per_task` and `fan_in` config.
