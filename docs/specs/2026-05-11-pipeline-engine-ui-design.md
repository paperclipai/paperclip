# Pipeline Engine UI — Design Spec

**Author:** Lior Franko  
**Date:** 2026-05-11  
**Status:** Draft  
**Depends on:** `2026-05-10-pipeline-engine-design.md`

---

## Overview

An n8n-style visual UI for the pipeline-engine plugin that enables creating, editing, and monitoring YAML-defined pipelines through an interactive DAG canvas. The UI lives inside `packages/plugins/pipeline-engine/src/ui/` and renders via the host's plugin slot system across four surfaces: full page, issue detail tab, sidebar link, and dashboard widget.

## Goals

1. **Visual pipeline builder** — drag-and-drop canvas for authoring pipeline DAGs, stored as JSON
2. **Edge-based routing model** — conditions, branching, and error routing all live on edges (n8n-style)
3. **Execution replay** — click into any run and see per-stage status, output, errors, and timing on the canvas
4. **Run management** — trigger pipelines manually, cancel stuck runs, view history
5. **At-a-glance health** — dashboard widget showing active/stuck/completed run counts

## Non-goals

- YAML as a pipeline format (replaced by JSON — drop `js-yaml` dependency)
- File-based pipeline definitions in workspace repos (issue #2 is superseded by this design)
- Real-time collaborative editing
- Pipeline versioning/diffing UI (future)
- Sub-pipeline materialization UI (backend not yet implemented)
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
| `list-pipelines` | `{ companyId }` | `Array<PipelineDefinition>` | `plugin_state` keys matching `pipeline:*` |
| `get-pipeline` | `{ companyId, pipelineName }` | `PipelineDefinition` (JSON) | `plugin_state` key `pipeline:{name}` |
| `list-runs` | `{ companyId, issueId?, status?, limit? }` | `Array<PipelineRun>` | `pipeline_runs` table (**new query method needed in StateMachine**) |
| `get-run` | `{ runId }` | `{ run: PipelineRun, stages: PipelineStage[], pipelineDef: PipelineDefinition }` | Existing `getRun` + `getRunStages` + `JSON.parse(run.pipelineYaml)` |
| `list-agents` | `{ companyId }` | `Array<{ id, name }>` | `ctx.agents.list()` (same interface as `Dispatcher.agents`) |

### New Action Handlers (ctx.actions.register)

| Key | Params | Effect |
|---|---|---|
| `save-pipeline` | `{ companyId, pipeline: PipelineDefinition }` | Store full JSON in `plugin_state` as `pipeline:{name}`, update `trigger_labels` config from `pipeline.trigger.label`, **reload in-memory `pipelines` array and `TriggerMatcher`** |
| `delete-pipeline` | `{ companyId, pipelineName }` | Remove from `plugin_state`, remove from `trigger_labels`, reload in-memory state |
| `trigger-run` | `{ companyId, pipelineName, issueId }` | Look up pipeline from in-memory `pipelines` array, call `materializePipeline()` |
| `cancel-run` | `{ companyId, runId }` | Set run status to `cancelled` (new status, see below), bulk-update all `pending`/`running` stages to `skipped` (**new StateMachine method: `cancelRun`**) |

**New `PipelineRunStatus` value:** Add `"cancelled"` to the union type in `types.ts`. This distinguishes user-initiated cancellation from pipeline failure. The DB column is `TEXT` so no migration needed.

### Stream Channel

| Channel | Event shape | Emitted when |
|---|---|---|
| `run-progress` | `{ runId, stageId, status, error? }` | Stage status changes (running/completed/failed/skipped) |

Emit calls are added to `advancePipeline()`, `handleCommentEvent()`, and `handleStageFailure()`.

> **SDK confirmed:** `ctx.stream.emit()` and `usePluginStream()` are available in the plugin SDK (exported from `@paperclipai/plugin-sdk/ui`). No fallback needed.

### Manifest Changes

Update manifest `description` from "Deterministic YAML-defined state-machine pipeline engine..." to "Deterministic pipeline engine for orchestrating agent work."

Remove `pipelines_dir` from `instanceConfigSchema.properties` (file-based definitions are superseded by UI-authored JSON).

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

## Pipeline Definition Format (JSON)

The UI and engine share a single JSON format. No YAML. The visual canvas is the canonical editor; the JSON is what gets stored and executed.

### Schema

```typescript
interface PipelineDefinition {
  name: string;
  description: string;
  trigger: { label: string };
  stages: StageDefinition[];
  edges: EdgeDefinition[];
  positions: Record<string, { x: number; y: number }>;  // canvas layout
}

interface StageDefinition {
  id: string;
  type: "worker" | "classifier" | "parallel_fan_out" | "gate" | "sub-pipeline";
  // Type-specific fields:
  agent_role?: string;           // worker, classifier
  output_schema?: string;        // worker, classifier
  timeout?: string;              // all types
  checkpoint?: boolean;          // all types
  fan_in?: "all_complete" | "first_complete";  // parallel_fan_out, gate
  per_task?: boolean;            // parallel_fan_out, sub-pipeline
  ordering?: string;             // parallel_fan_out, sub-pipeline
  pipeline?: string;             // sub-pipeline
  requires_approval?: boolean;   // gate (future)
  retry?: {                      // node-level retry config
    max_retries: number;
    body?: string;               // Handlebars template
  };
}

interface EdgeDefinition {
  id: string;
  from: string;                  // source stage id
  to: string;                    // target stage id
  type?: "default" | "error";    // default = forward flow, error = failure routing
  when?: string;                 // condition expression (only on default edges)
  label?: string;                // display label on canvas
}
```

### Example

```json
{
  "name": "feature-pipeline",
  "description": "End-to-end feature development workflow",
  "trigger": { "label": "pipeline:feature" },
  "stages": [
    { "id": "spec-review", "type": "worker", "agent_role": "reviewer", "output_schema": "schemas/spec-review-output.json", "checkpoint": true },
    { "id": "classify", "type": "classifier", "agent_role": "architect", "output_schema": "schemas/classify-output.json" },
    { "id": "implement", "type": "worker", "agent_role": "developer", "retry": { "max_retries": 2, "body": "Fix: {{output.issues}}" } },
    { "id": "hotfix", "type": "worker", "agent_role": "developer" },
    { "id": "validate", "type": "worker", "agent_role": "validator" }
  ],
  "edges": [
    { "id": "e1", "from": "spec-review", "to": "classify" },
    { "id": "e2", "from": "classify", "to": "implement", "when": "output.type == 'feature'", "label": "feature" },
    { "id": "e3", "from": "classify", "to": "hotfix", "when": "output.type == 'bug'", "label": "bug" },
    { "id": "e4", "from": "implement", "to": "validate" },
    { "id": "e5", "from": "validate", "to": "implement", "type": "error", "label": "retry" }
  ],
  "positions": {
    "spec-review": { "x": 300, "y": 100 },
    "classify": { "x": 300, "y": 250 },
    "implement": { "x": 200, "y": 400 },
    "hotfix": { "x": 450, "y": 400 },
    "validate": { "x": 200, "y": 550 }
  }
}
```

### How the engine uses edges

The current router derives "ready stages" from `depends_on`. The new router works differently:

1. **Forward edges** (`type: "default"` or omitted): a stage is ready when ALL its incoming forward edges have their source stage completed AND the edge's `when` condition (if any) evaluates to true against the source's output.
2. **Error edges** (`type: "error"`): when a stage fails and has retry config, the engine follows the error edge to determine the retry target. The target stage is reset and re-dispatched with the retry body template.
3. **Stage with no incoming edges**: starts immediately (root node).
4. **Stage with multiple incoming edges**: waits for all sources to complete (AND semantics by default; `fan_in: "first_complete"` changes to OR).
5. **Conditional branches**: if a stage has multiple outgoing forward edges with `when` conditions, only edges whose condition evaluates true are followed. Stages reachable only via false-condition edges are marked `skipped`.

### Storage

- **Plugin state key**: `pipeline:{name}` — stores the full JSON definition (renamed from current `yaml:{name}` key — migration must rename existing keys)
- **Pipeline runs**: `pipeline_runs.pipeline_yaml` column stores this JSON (snapshotted at materialization time). Column retains the `pipeline_yaml` name for backwards compatibility despite now storing JSON.
- **No separate positions key** — positions are embedded in the definition

### Migration from current format

The existing `depends_on` + `condition` + `on_failure` model is replaced. A one-time migration transforms existing pipelines:
- **State key rename**: `yaml:{name}` → `pipeline:{name}` (iterate all `plugin_state` keys matching `yaml:*`, rename and re-store as JSON)
- `depends_on: [a, b]` on stage X → edges `{ from: "a", to: "X" }` and `{ from: "b", to: "X" }`
- `condition` on stage X → `when` on the incoming edge
- `on_failure.retry_with.goto: Y` → error edge `{ from: "X", to: "Y", type: "error" }` + `retry` config on stage X
- `skip_if` on stage X → removed (unreachable nodes simply have no active edge path)

---

## Dependencies

**New npm packages for pipeline-engine:**
- `@xyflow/react` — ReactFlow canvas
- `dagre` — auto-layout algorithm
- `@types/dagre` — types

**Retained packages:**
- `handlebars` — still needed for retry body template rendering (`template-engine.ts`)

**Removed packages:**
- `js-yaml` — no longer needed (pipelines are JSON, not YAML)
- `@types/js-yaml` — removed with js-yaml

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
│  Router (rewritten: edge-based traversal)                   │
│  StateMachine ←→ PostgreSQL (pipeline_runs, pipeline_stages)│
│  plugin_state  ←→ JSON pipeline definitions                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Engine Refactoring (Router + Types)

The current router (`router.ts`) uses `depends_on` to derive ready stages. It must be rewritten for edge-based traversal:

**Current `types.ts` changes:**
- Remove `depends_on`, `condition`, `skip_if`, `on_failure` from `StageDefinition`
- Add `retry?: { max_retries: number; body?: string }` to `StageDefinition`
- Add `EdgeDefinition` type (as defined above)
- Add `edges` and `positions` to `PipelineDefinition`

**Current `router.ts` rewrite:**
- `getReadyStages()` → traverse forward edges from completed stages, evaluate `when` conditions
- `getSkippedStages()` → stages reachable only via edges with false `when` conditions
- `evaluateFailure()` → find error edge from failed stage, check retry config

**Current `dag-parser.ts` rewrite:**
- `parsePipeline()` → `JSON.parse()` + validate structure (drop `js-yaml`)
- `validateDAG()` → validate edges reference existing stage IDs, check for cycles

**Current `expression-engine.ts`:**
- `buildExpressionContext()` → keep, but adapt to work with edge `when` expressions
- Edge `when` expressions evaluate against the **source stage's output** (e.g., `output.type == 'feature'`), but the full `ExpressionContext` (all stages, pipeline meta, env) remains available for complex conditions

**Current `trigger-matcher.ts`:**
- Keep as-is — still matches issue labels to `pipeline.trigger.label`

**Current `worker.ts` refactoring:**
The worker has three call sites that directly use `depends_on`-based logic and must be rewritten for edge-based traversal:
- `buildStageContext()` — uses `stageDef.depends_on` to find upstream outputs. Rewrite: traverse incoming edges to find source stages.
- `handleCheckpointCompletion()` — uses `s.depends_on.includes(checkpointStageDef.id)` to find downstream stages. Rewrite: find outgoing edges from the checkpoint stage.
- `handleStageFailure()` — builds adjacency map from `s.depends_on` for `resetDownstreamStages`. Rewrite: build adjacency from `pipeline.edges` (forward edges only).

## Testing Strategy

- **Unit tests:** Edge-based router (ready stages, skipped stages, error routing)
- **Unit tests:** Pipeline definition validation (cycles, dangling edges, missing stages)
- **Unit tests:** Data/action handlers with mocked DB
- **Storybook stories:** StageNode in each type + status variant, StagePalette, StageInspector per type
- **Integration scenario:** Create pipeline in UI → verify JSON in plugin_state → trigger run → verify stages advance via edges → verify replay shows correct status

---

## New StateMachine Methods Required

| Method | Signature | Purpose |
|---|---|---|
| `listRuns` | `(companyId, opts?: { issueId?, status?, limit? })` → `PipelineRun[]` | Multi-run listing with filters |
| `cancelRun` | `(runId)` → void | Set run to `cancelled`, bulk-set pending/running stages to `skipped`, release advisory lock if held |

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

1. **Node positions** — embedded in the pipeline definition JSON (`positions` field). No separate storage key.
2. **Pipeline format** — pure JSON, no YAML. `js-yaml` dependency removed. The UI is the primary authoring tool.
3. **Routing model** — edge-based. `depends_on`, `condition`, `skip_if`, `on_failure` removed from stages. All routing through `edges[]` array.
4. **Retry model** — retry config (max_retries, body) lives on the stage. Error routing (where to retry) is an `on: error` edge. Matches n8n's split of retry config vs error routing. `handlebars` dependency retained for body template rendering.
5. **Approval gates** — UI shows gate nodes with a "requires approval" badge but the interactive approve/reject buttons are deferred until the backend implements `requires_approval` handling.
6. **Sub-pipeline drill-in** — UI shows sub-pipeline nodes as non-expandable (disabled "Drill in" button) until backend implements sub-pipeline materialization.
7. **`parallel_fan_out` inline stages** — NOT represented as nested nodes on the canvas. The fan-out node is a single card; its inline `stages[]` field is removed from the type (fan-out dispatches its `agent_role` with `per_task`/`fan_in` config).
8. **DB column name** — `pipeline_runs.pipeline_yaml` column retains its name despite now storing JSON. Renaming would require a migration for no functional benefit.
9. **Expression scope** — edge `when` conditions receive the full `ExpressionContext` (all stages, pipeline meta, env) but are documented as evaluating against the source stage's output for simplicity. Complex cross-stage conditions are supported.
10. **State key rename** — existing `yaml:{name}` keys migrate to `pipeline:{name}` as part of the format migration.
11. **`pipelines_dir` removal** — config field removed from manifest; file-based pipeline definitions are superseded by UI-authored JSON.
