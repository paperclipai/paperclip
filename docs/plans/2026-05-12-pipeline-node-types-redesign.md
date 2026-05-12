# Pipeline Node Types Redesign — Implementation Plan

> **For agentic workers:** REQUIRED: Use forge:subagent-driven-development (if subagents available) or forge:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse Worker/Classifier/Gate into a unified "Stage" type with enum-based `decision` routing, add per-enum-value output handles on the canvas, and show agent instructions on node cards.

**Architecture:** Replace five node types with four (Stage, Fan Out, Fan In, Sub-Pipeline). Schemas gain an `enum` constraint on a `decision` field that drives visual routing handles. The condition builder is removed entirely — routing is determined by edge-to-handle bindings on `decision` values.

**Tech Stack:** TypeScript, React, ReactFlow (@xyflow/react), JSON Schema

**Verification Criteria:**
- [ ] Stage nodes render one output handle per `decision` enum value from their output schema
- [ ] Dragging an edge from a labeled handle to a target binds that decision value to the edge
- [ ] Save validation flags uncovered decision values (enum values with no outgoing edge)
- [ ] Node cards show ~2 lines of agent instructions; inspector shows full text
- [ ] Condition builder is removed from inspector (both stage and edge forms)
- [ ] Backend router uses edge `sourceHandle` (decision value) to match stage output instead of `when` expressions
- [ ] Existing tests updated to pass with new types
- [ ] Fan In node type works as sync primitive (strategy config, no agent)

---

## File Structure

### New Files
- `packages/plugins/pipeline-engine/src/schema-utils.ts` — parse JSON Schema to extract `decision` enum values
- `packages/plugins/pipeline-engine/src/tests/schema-utils.test.ts`

### Modified Files
- `packages/plugins/pipeline-engine/src/types.ts` — new stage type union (Stage, FanOut, FanIn, SubPipeline)
- `packages/plugins/pipeline-engine/schemas/*.json` — add `enum` to `decision` fields
- `packages/plugins/pipeline-engine/src/ui/components/StageNode.tsx` — multiple output handles, instruction preview
- `packages/plugins/pipeline-engine/src/ui/components/StageInspector.tsx` — remove condition builder, add full instructions field
- `packages/plugins/pipeline-engine/src/ui/components/StagePalette.tsx` — 4 node types instead of 5
- `packages/plugins/pipeline-engine/src/ui/components/PipelineCanvas.tsx` — handle-based edge connections, pass schema data to nodes
- `packages/plugins/pipeline-engine/src/ui/components/ValidationErrors.tsx` — exhaustiveness check
- `packages/plugins/pipeline-engine/src/router.ts` — route by `decision` value on edge instead of `when` expression
- `packages/plugins/pipeline-engine/src/edge-utils.ts` — update edge shape for `sourceHandle` field
- `packages/plugins/pipeline-engine/src/tests/router-edge-based.test.ts` — update existing tests for new routing
- `packages/plugins/pipeline-engine/src/tests/integration.test.ts` — update for new types
- `packages/plugins/pipeline-engine/src/worker.ts` — add `list-schema-contents` data handler

### Deleted Files
- `packages/plugins/pipeline-engine/src/ui/components/ConditionBuilder.tsx` — no longer needed

---

## Chunk 1: Types, Schemas, and Schema Utils

### Task 1: Update type definitions

**Files:**
- Modify: `packages/plugins/pipeline-engine/src/types.ts`

- [ ] **Step 1: Write the new type definitions**

Replace the current 5-type union with 4 types:

```typescript
export type StageType = "stage" | "fan_out" | "fan_in" | "sub-pipeline";

export type FanInStrategy = "all_complete" | "first_complete" | "n_of_m";

interface BaseStage {
  id: string;
}

export interface Stage extends BaseStage {
  type: "stage";
  agent_role: string;
  instructions?: string;
  output_schema?: string;
}

export interface FanOutStage extends BaseStage {
  type: "fan_out";
  agent_role?: string;
  instructions?: string;
  per_task?: boolean;
  ordering?: string;
}

export interface FanInStage extends BaseStage {
  type: "fan_in";
  fan_in_strategy: FanInStrategy;
}

export interface SubPipelineStage extends BaseStage {
  type: "sub-pipeline";
  pipeline: string;
  per_task?: boolean;
  ordering?: string;
}

export type StageDefinition = Stage | FanOutStage | FanInStage | SubPipelineStage;
```

Remove `StageRetry` interface, `timeout`, `checkpoint`, and `retry` fields entirely — these are handled by the platform.

> **Migration note:** The current `WorkerStage` has a `fan_in?: FanInStrategy` field used by the router to require all/first incoming edges to be satisfied. This behavior now moves to `FanInStage` — a dedicated sync node placed where fan-in semantics are needed. Any existing pipeline using `fan_in` on a worker stage must be migrated to insert a `FanInStage` node before the worker.

Also update `EdgeDefinition` to add `sourceHandle`:

```typescript
export interface EdgeDefinition {
  id: string;
  from: string;
  to: string;
  type?: "default" | "error";
  sourceHandle?: string;  // decision enum value, e.g. "approved"
  label?: string;
}
```

Remove the `when` field from `EdgeDefinition`.

- [ ] **Step 2: Fix all TypeScript compilation errors from the type change**

Run: `pnpm --filter pipeline-engine exec tsc --noEmit`

Update references throughout the package. This will cascade — just fix type errors at this stage, not behavior.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/pipeline-engine/src/types.ts
git commit -m "refactor(pipeline-engine): replace 5 node types with unified Stage/FanOut/FanIn/SubPipeline"
```

---

### Task 2: Add `decision` enum to schemas

**Files:**
- Modify: `packages/plugins/pipeline-engine/schemas/review-output.json`
- Modify: `packages/plugins/pipeline-engine/schemas/spec-review-output.json`
- Modify: `packages/plugins/pipeline-engine/schemas/classification-output.json`
- Modify: `packages/plugins/pipeline-engine/schemas/validation-output.json`
- Modify: `packages/plugins/pipeline-engine/schemas/implementation-output.json`
- Modify: `packages/plugins/pipeline-engine/schemas/test-writing-output.json`
- Modify: `packages/plugins/pipeline-engine/schemas/decomposition-output.json`
- Modify: `packages/plugins/pipeline-engine/schemas/merge-output.json`
- Modify: `packages/plugins/pipeline-engine/schemas/pr-output.json`

- [ ] **Step 1: Add enum constraints to decision fields**

Each schema that represents a decision point should have:

```json
{
  "decision": {
    "type": "string",
    "enum": ["approved", "needs_revision", "rejected"]
  }
}
```

For schemas that are pure work output (no branching), add a simple success/error enum:

```json
{
  "decision": {
    "type": "string",
    "enum": ["success", "error"]
  }
}
```

> **Breaking change note:** `classification-output.json` currently has a `classification` field (not `decision`). Renaming it to `decision` requires updating any existing pipeline definitions that reference this schema's output by the old field name. Check existing saved pipelines before deploying.

Specific enum values per schema:
- `review-output.json`: already has `decision` field — add `"enum": ["approved", "needs_revision", "rejected"]`
- `spec-review-output.json`: `["approved", "needs_revision", "rejected"]`
- `classification-output.json`: rename `classification` field to `decision`, enum values depend on use-case — use `["route_a", "route_b", "route_c"]` as placeholder
- `validation-output.json`: `["pass", "fail"]`
- `implementation-output.json`: `["success", "error"]`
- `test-writing-output.json`: `["success", "error"]`
- `decomposition-output.json`: `["success", "error"]`
- `merge-output.json`: `["success", "error"]`
- `pr-output.json`: `["success", "error"]`

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/pipeline-engine/schemas/
git commit -m "feat(pipeline-engine): add decision enum constraints to output schemas"
```

---

### Task 3: Create schema-utils module

**Files:**
- Create: `packages/plugins/pipeline-engine/src/schema-utils.ts`
- Create: `packages/plugins/pipeline-engine/src/tests/schema-utils.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { getDecisionEnumValues } from "../schema-utils.js";

describe("getDecisionEnumValues", () => {
  it("extracts enum values from decision field", () => {
    const schema = {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["approved", "rejected", "needs_revision"] },
        summary: { type: "string" },
      },
    };
    expect(getDecisionEnumValues(schema)).toEqual(["approved", "rejected", "needs_revision"]);
  });

  it("returns empty array when no decision field", () => {
    const schema = { type: "object", properties: { result: { type: "string" } } };
    expect(getDecisionEnumValues(schema)).toEqual([]);
  });

  it("returns empty array when decision has no enum", () => {
    const schema = { type: "object", properties: { decision: { type: "string" } } };
    expect(getDecisionEnumValues(schema)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter pipeline-engine exec vitest run src/tests/schema-utils.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
export interface JsonSchema {
  type?: string;
  properties?: Record<string, { type?: string; enum?: string[] }>;
  [key: string]: unknown;
}

export function getDecisionEnumValues(schema: JsonSchema): string[] {
  const decision = schema.properties?.decision;
  if (!decision || !decision.enum) return [];
  return decision.enum;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter pipeline-engine exec vitest run src/tests/schema-utils.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pipeline-engine/src/schema-utils.ts packages/plugins/pipeline-engine/src/tests/schema-utils.test.ts
git commit -m "feat(pipeline-engine): add schema-utils to extract decision enum values"
```

---

## Chunk 2: Backend Router Update

### Task 4: Update router to use sourceHandle-based routing

**Files:**
- Modify: `packages/plugins/pipeline-engine/src/router.ts`
- Modify: `packages/plugins/pipeline-engine/src/tests/router-edge-based.test.ts` (file already exists with conditional edge tests — update existing tests)

- [ ] **Step 1: Update existing tests and add new tests for handle-based routing**

> **Note:** `router-edge-based.test.ts` already exists with tests for `when`-based conditional edges, unconditional edges, fan_in strategies, and sub-pipeline handling. Update these tests to use `sourceHandle` instead of `when`, and add new test cases as needed.

```typescript
import { describe, it, expect } from "vitest";
import { Router } from "../router.js";
import type { PipelineDefinition, PipelineStage } from "../types.js";

describe("Router - decision-based routing", () => {
  const router = new Router();

  it("activates stage connected to matching decision handle", async () => {
    const pipeline: PipelineDefinition = {
      name: "test",
      description: "",
      trigger: { label: "test" },
      stages: [
        { id: "review", type: "stage", agent_role: "reviewer", output_schema: "review-output" },
        { id: "implement", type: "stage", agent_role: "dev" },
        { id: "revise", type: "stage", agent_role: "dev" },
      ],
      edges: [
        { id: "e1", from: "review", to: "implement", sourceHandle: "approved" },
        { id: "e2", from: "review", to: "revise", sourceHandle: "needs_revision" },
      ],
      positions: {},
    };

    const stageRows: PipelineStage[] = [
      { id: "1", pipelineRunId: "r1", stageId: "review", subIssueId: null, status: "completed", retryCount: 0, output: { decision: "approved" }, error: null, startedAt: new Date(), completedAt: new Date() },
      { id: "2", pipelineRunId: "r1", stageId: "implement", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
      { id: "3", pipelineRunId: "r1", stageId: "revise", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
    ];

    const ready = await router.getReadyStages(pipeline, stageRows, "company1");
    expect(ready.map((s) => s.id)).toEqual(["implement"]);
  });

  it("skips stage when decision does not match its handle", async () => {
    const pipeline: PipelineDefinition = {
      name: "test",
      description: "",
      trigger: { label: "test" },
      stages: [
        { id: "review", type: "stage", agent_role: "reviewer" },
        { id: "implement", type: "stage", agent_role: "dev" },
        { id: "revise", type: "stage", agent_role: "dev" },
      ],
      edges: [
        { id: "e1", from: "review", to: "implement", sourceHandle: "approved" },
        { id: "e2", from: "review", to: "revise", sourceHandle: "needs_revision" },
      ],
      positions: {},
    };

    const stageRows: PipelineStage[] = [
      { id: "1", pipelineRunId: "r1", stageId: "review", subIssueId: null, status: "completed", retryCount: 0, output: { decision: "needs_revision" }, error: null, startedAt: new Date(), completedAt: new Date() },
      { id: "2", pipelineRunId: "r1", stageId: "implement", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
      { id: "3", pipelineRunId: "r1", stageId: "revise", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
    ];

    const ready = await router.getReadyStages(pipeline, stageRows, "company1");
    expect(ready.map((s) => s.id)).toEqual(["revise"]);
  });

  it("unconditional edges (no sourceHandle) activate when source completes", async () => {
    const pipeline: PipelineDefinition = {
      name: "test",
      description: "",
      trigger: { label: "test" },
      stages: [
        { id: "work", type: "stage", agent_role: "dev" },
        { id: "next", type: "stage", agent_role: "dev" },
      ],
      edges: [
        { id: "e1", from: "work", to: "next" },
      ],
      positions: {},
    };

    const stageRows: PipelineStage[] = [
      { id: "1", pipelineRunId: "r1", stageId: "work", subIssueId: null, status: "completed", retryCount: 0, output: { decision: "success" }, error: null, startedAt: new Date(), completedAt: new Date() },
      { id: "2", pipelineRunId: "r1", stageId: "next", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
    ];

    const ready = await router.getReadyStages(pipeline, stageRows, "company1");
    expect(ready.map((s) => s.id)).toEqual(["next"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail (before implementation)**

Run: `pnpm --filter pipeline-engine exec vitest run src/tests/router-edge-based.test.ts`

- [ ] **Step 3: Update router implementation**

In `router.ts`, change the edge satisfaction logic:

For each incoming edge:
- If `edge.sourceHandle` is set: the edge is satisfied only if the source stage's `output.decision === edge.sourceHandle`
- If `edge.sourceHandle` is not set: the edge is satisfied when the source stage completes (existing unconditional behavior)

Remove all `when` expression evaluation from `getReadyStages` and `getSkippedStages`.

```typescript
// Inside the loop over incomingEdges:
if (edge.sourceHandle) {
  const sourceOutput = sourceRow.output as { decision?: string } | null;
  if (sourceOutput?.decision === edge.sourceHandle) {
    satisfiedEdges.push(edge);
  }
} else {
  satisfiedEdges.push(edge);
}
```

Also update `getSkippedStages` with the same logic — a stage is skipped when all sources are resolved but no edge is satisfied.

Update `requiresAgentDispatch`:
```typescript
requiresAgentDispatch(stageDef: StageDefinition): boolean {
  return stageDef.type === "stage" || stageDef.type === "fan_out";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter pipeline-engine exec vitest run src/tests/router-edge-based.test.ts`
Expected: PASS

- [ ] **Step 5: Update remaining router tests**

Fix any other tests in `src/tests/` that reference old types (worker, classifier, gate) or `when` conditions.

Run: `pnpm --filter pipeline-engine exec vitest run`

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/pipeline-engine/src/router.ts packages/plugins/pipeline-engine/src/tests/
git commit -m "feat(pipeline-engine): route by decision sourceHandle instead of when expressions"
```

---

## Chunk 3: UI — Node Rendering with Output Handles

### Task 5: Update StagePalette to 4 node types

**Files:**
- Modify: `packages/plugins/pipeline-engine/src/ui/components/StagePalette.tsx`

- [ ] **Step 1: Replace STAGE_TYPES array**

```typescript
const STAGE_TYPES: StageTypeCard[] = [
  {
    type: "stage",
    label: "Stage",
    description: "Agent performs work and routes by decision",
    color: "#3b82f6",
    badge: "STG",
  },
  {
    type: "fan_out",
    label: "Fan Out",
    description: "Distribute work across multiple parallel agents",
    color: "#06b6d4",
    badge: "FAN",
  },
  {
    type: "fan_in",
    label: "Fan In",
    description: "Wait for parallel branches to complete",
    color: "#8b5cf6",
    badge: "FIN",
  },
  {
    type: "sub-pipeline",
    label: "Sub-Pipeline",
    description: "Invoke a nested pipeline definition",
    color: "#22c55e",
    badge: "SUB",
  },
];
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/components/StagePalette.tsx
git commit -m "refactor(pipeline-engine): update palette to 4 node types"
```

---

### Task 6: Update StageNode with multiple output handles and instruction preview

**Files:**
- Modify: `packages/plugins/pipeline-engine/src/ui/components/StageNode.tsx`

- [ ] **Step 1: Update StageNodeData interface and add decisionValues**

```typescript
export interface StageNodeData {
  stage: StageDefinition;
  status?: StageStatus;
  subtitle?: string;
  decisionValues?: string[];  // enum values from output schema
  onSelect?: (id: string) => void;
}
```

- [ ] **Step 2: Update the node component to render per-value output handles**

Key changes:
- Show ~2 lines of `instructions` text (truncated with ellipsis) below the stage ID
- Replace single bottom Handle with one Handle per decision value, spaced horizontally
- Each handle has an `id` matching the enum value
- Label each handle with the enum value text

```typescript
export function StageNode({ data, selected, id }: NodeProps) {
  const nodeData = data as unknown as StageNodeData;
  const { stage, status, subtitle, decisionValues, onSelect } = nodeData;
  const typeColor = TYPE_COLORS[stage.type] ?? "#6b7280";
  const badge = TYPE_BADGES[stage.type] ?? "???";
  const border = getBorderStyle(status);
  const instructions = "instructions" in stage ? stage.instructions : undefined;
  const hasDecisionHandles = decisionValues && decisionValues.length > 0;

  return (
    <div ...>
      {/* ... existing color strip and badge ... */}

      {/* Content */}
      <div style={{ padding: "10px 32px 10px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ color: "#f9fafb", fontSize: 13, fontWeight: 600 }}>{stage.id}</div>
        {"agent_role" in stage && stage.agent_role && (
          <div style={{ color: "#9ca3af", fontSize: 11 }}>{stage.agent_role}</div>
        )}
        {instructions && (
          <div style={{
            color: "#6b7280",
            fontSize: 10,
            lineHeight: 1.3,
            overflow: "hidden",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
          }}>
            {instructions}
          </div>
        )}
      </div>

      {/* Target handle (top) */}
      <Handle type="target" position={Position.Top} ... />

      {/* Source handles (bottom) */}
      {hasDecisionHandles ? (
        decisionValues.map((value, idx) => (
          <Handle
            key={value}
            type="source"
            position={Position.Bottom}
            id={value}
            style={{
              left: `${((idx + 1) / (decisionValues.length + 1)) * 100}%`,
              background: "#374151",
              border: "2px solid #6b7280",
              width: 10,
              height: 10,
            }}
          />
        ))
      ) : (
        <Handle type="source" position={Position.Bottom} ... />
      )}

      {/* Decision labels below handles */}
      {hasDecisionHandles && (
        <div style={{
          position: "absolute",
          bottom: -18,
          left: 0,
          right: 0,
          display: "flex",
          justifyContent: "space-around",
          pointerEvents: "none",
        }}>
          {decisionValues.map((value) => (
            <span key={value} style={{ fontSize: 8, color: "#6b7280" }}>{value}</span>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Update TYPE_COLORS and TYPE_BADGES maps**

```typescript
const TYPE_COLORS: Record<string, string> = {
  stage: "#3b82f6",
  fan_out: "#06b6d4",
  fan_in: "#8b5cf6",
  "sub-pipeline": "#22c55e",
};

const TYPE_BADGES: Record<string, string> = {
  stage: "STG",
  fan_out: "FAN",
  fan_in: "FIN",
  "sub-pipeline": "SUB",
};
```

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/components/StageNode.tsx
git commit -m "feat(pipeline-engine): render per-decision output handles and instruction preview on nodes"
```

---

### Task 7: Update PipelineCanvas to pass schema data to nodes and handle sourceHandle on edges

**Files:**
- Modify: `packages/plugins/pipeline-engine/src/ui/components/PipelineCanvas.tsx`

- [ ] **Step 1: Load schema contents and compute decision values per stage**

Add a new data key and fetch schema contents. In `buildNodes`, pass `decisionValues` to each node's data based on its `output_schema`.

```typescript
// Add to imports
import { getDecisionEnumValues, type JsonSchema } from "../../schema-utils.js";

// In PipelineCanvas component, fetch schemas data
const { data: schemaContents } = usePluginData<{ schemas: Record<string, JsonSchema> }>(
  DATA_KEYS.LIST_SCHEMA_CONTENTS, {}
);

// Build decision values map
const decisionMap = useMemo(() => {
  const map: Record<string, string[]> = {};
  if (!schemaContents?.schemas) return map;
  for (const [name, schema] of Object.entries(schemaContents.schemas)) {
    map[name] = getDecisionEnumValues(schema);
  }
  return map;
}, [schemaContents]);
```

Pass into `buildNodes`:
```typescript
function buildNodes(pipeline: PipelineDefinition, decisionMap: Record<string, string[]>) {
  return pipeline.stages.map((stage) => {
    const pos = pipeline.positions?.[stage.id] ?? { x: 0, y: 0 };
    const schemaName = "output_schema" in stage ? stage.output_schema : undefined;
    const decisionValues = schemaName ? decisionMap[schemaName] ?? [] : [];
    return {
      id: stage.id,
      type: "stage" as const,
      position: pos,
      data: { stage, decisionValues } as unknown as StageNodeData,
    };
  });
}
```

- [ ] **Step 2: Update handleConnect to record sourceHandle**

When a connection is made from a specific handle, ReactFlow provides `connection.sourceHandle`. Store it on the edge:

```typescript
const handleConnect = useCallback((connection: Connection) => {
  const id = `e-${connection.source}-${connection.target}-${Date.now()}`;
  const newEdge: EdgeDefinition = {
    id,
    from: connection.source!,
    to: connection.target!,
    sourceHandle: connection.sourceHandle ?? undefined,
  };
  setEdgeDefs((prev) => [...prev, newEdge]);
  // ... update ReactFlow edges
}, []);
```

- [ ] **Step 3: Update buildEdges to include sourceHandle**

```typescript
function buildEdges(pipeline: PipelineDefinition): Edge[] {
  return (pipeline.edges ?? []).map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    sourceHandle: e.sourceHandle ?? null,
    label: e.sourceHandle ?? e.label,
    data: { type: e.type, sourceHandle: e.sourceHandle },
    style: { stroke: e.type === "error" ? "#ef4444" : "#374151", strokeWidth: 2 },
    animated: false,
  }));
}
```

- [ ] **Step 4: Update stageDefaults for new types**

```typescript
function stageDefaults(type: StageType, id: string): StageDefinition {
  switch (type) {
    case "stage":
      return { id, type: "stage", agent_role: "" };
    case "fan_out":
      return { id, type: "fan_out" };
    case "fan_in":
      return { id, type: "fan_in", fan_in_strategy: "all_complete" };
    case "sub-pipeline":
      return { id, type: "sub-pipeline", pipeline: "" };
  }
}
```

- [ ] **Step 5: Update edge-utils.ts for new edge shape**

Update `packages/plugins/pipeline-engine/src/edge-utils.ts` to handle the `sourceHandle` field on `EdgeDefinition` (replacing `when`). Ensure any edge serialization/deserialization preserves the `sourceHandle` value.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/components/PipelineCanvas.tsx packages/plugins/pipeline-engine/src/edge-utils.ts
git commit -m "feat(pipeline-engine): wire schema decision values to canvas nodes and edges"
```

---

## Chunk 4: UI — Inspector and Validation

### Task 8: Update StageInspector — remove conditions, add instructions

**Files:**
- Modify: `packages/plugins/pipeline-engine/src/ui/components/StageInspector.tsx`
- Delete: `packages/plugins/pipeline-engine/src/ui/components/ConditionBuilder.tsx`

- [ ] **Step 1: Remove ConditionBuilder from StageForm**

Remove the `ConditionBuilder` import and the `<FieldGroup label="Condition">` block from `StageForm`.

- [ ] **Step 2: Remove ConditionBuilder from EdgeInspector**

Remove the condition field from `EdgeInspector`. Replace with a read-only display of `sourceHandle` if present:

```typescript
{edge.data?.sourceHandle && (
  <FieldGroup label="Routes on decision">
    <div style={{ ...inputStyle, background: "#0f172a", color: "#9ca3af" }}>
      {edge.data.sourceHandle}
    </div>
  </FieldGroup>
)}
```

- [ ] **Step 3: Add instructions textarea to StageForm**

For stage type "stage" and "fan_out", add a full-height textarea:

```typescript
{(stage.type === "stage" || stage.type === "fan_out") && (
  <FieldGroup label="Instructions">
    <textarea
      style={{ ...inputStyle, minHeight: 120, resize: "vertical" }}
      value={(stage as any).instructions ?? ""}
      onChange={(e) => update({ instructions: e.target.value || undefined } as any)}
      placeholder="Agent instructions..."
    />
  </FieldGroup>
)}
```

- [ ] **Step 4: Update type dropdown options**

```typescript
<select ...>
  <option value="stage">Stage</option>
  <option value="fan_out">Fan Out</option>
  <option value="fan_in">Fan In</option>
  <option value="sub-pipeline">Sub-Pipeline</option>
</select>
```

- [ ] **Step 5: Remove Timeout, Checkpoint, and Retry Config sections**

Delete the `<FieldGroup label="Timeout">`, `<FieldGroup label="Checkpoint">`, and the entire "Retry Config" section (Max Retries + Retry Body). These are handled by the platform.

- [ ] **Step 6: Update conditional field rendering for new types**

- Agent Role + Output Schema: show for `stage` type (and optionally `fan_out`)
- Fan-In Strategy: show only for `fan_in` type
- Pipeline Reference: show for `sub-pipeline`
- Per Task / Ordering: show for `fan_out` and `sub-pipeline`

- [ ] **Step 7: Delete ConditionBuilder.tsx**

```bash
rm packages/plugins/pipeline-engine/src/ui/components/ConditionBuilder.tsx
```

- [ ] **Step 8: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/components/StageInspector.tsx
git rm packages/plugins/pipeline-engine/src/ui/components/ConditionBuilder.tsx
git commit -m "feat(pipeline-engine): remove condition builder, add instructions to inspector"
```

---

### Task 9: Update save validation for exhaustiveness

**Files:**
- Modify: `packages/plugins/pipeline-engine/src/ui/components/ValidationErrors.tsx`

- [ ] **Step 1: Add exhaustiveness check to validatePipeline**

Add a validation rule: for each stage with a `decision` enum (via its output_schema), every enum value must have a corresponding outgoing edge with matching `sourceHandle`.

```typescript
// Add parameter: decisionMap: Record<string, string[]>
export function validatePipeline(
  pipeline: PipelineDefinition,
  decisionMap: Record<string, string[]>,
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const stage of pipeline.stages) {
    if (stage.type !== "stage") continue;
    const schemaName = stage.output_schema;
    if (!schemaName) continue;
    const enumValues = decisionMap[schemaName];
    if (!enumValues || enumValues.length === 0) continue;

    const outgoingEdges = pipeline.edges.filter((e) => e.from === stage.id && e.type !== "error");
    const coveredValues = new Set(outgoingEdges.map((e) => e.sourceHandle).filter(Boolean));

    for (const value of enumValues) {
      if (!coveredValues.has(value)) {
        errors.push({
          stageId: stage.id,
          message: `Missing outgoing edge for decision "${value}"`,
        });
      }
    }
  }

  // ... existing validations (orphan stages, etc.)
  return errors;
}
```

- [ ] **Step 2: Update call site in PipelineCanvas to pass decisionMap**

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/components/ValidationErrors.tsx packages/plugins/pipeline-engine/src/ui/components/PipelineCanvas.tsx
git commit -m "feat(pipeline-engine): validate exhaustive decision coverage on save"
```

---

## Chunk 5: Backend Data Handler and Cleanup

### Task 10: Add LIST_SCHEMA_CONTENTS data handler

**Files:**
- Modify: `packages/plugins/pipeline-engine/src/worker.ts` (data handlers are registered via `ctx.data.register()` at ~line 607)
- Modify: `packages/plugins/pipeline-engine/src/ui/constants.ts`

- [ ] **Step 1: Add `list-schema-contents` handler in worker.ts**

The existing `list-schemas` handler (worker.ts:607) reads schema filenames from disk but only returns names. Add a new handler that returns full parsed JSON schema objects keyed by name:

```typescript
ctx.data.register("list-schema-contents", async () => {
  const candidates = [
    resolve(dirname(fileURLToPath(import.meta.url)), "../schemas"),
    resolve(dirname(fileURLToPath(import.meta.url)), "./schemas"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../schemas"),
  ];
  for (const dir of candidates) {
    try {
      const files = readdirSync(dir);
      const schemas: Record<string, unknown> = {};
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const content = readFileSync(resolve(dir, f), "utf-8");
        schemas[f.replace(/\.json$/, "")] = JSON.parse(content);
      }
      if (Object.keys(schemas).length > 0) return { schemas };
    } catch {}
  }
  return { schemas: {} };
});
```

- [ ] **Step 2: Add DATA_KEYS.LIST_SCHEMA_CONTENTS constant**

In `src/ui/constants.ts`:
```typescript
LIST_SCHEMA_CONTENTS: "list-schema-contents",
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/pipeline-engine/src/worker.ts packages/plugins/pipeline-engine/src/ui/constants.ts
git commit -m "feat(pipeline-engine): add data handler for schema contents with enum values"
```

---

### Task 11: Update remaining tests and fix integration

**Files:**
- Modify: `packages/plugins/pipeline-engine/src/tests/integration.test.ts`
- Modify: `packages/plugins/pipeline-engine/src/tests/state-machine.test.ts`
- Modify: `packages/plugins/pipeline-engine/src/tests/dispatcher.test.ts`

- [ ] **Step 1: Update all test fixtures from old types to new types**

Replace `type: "worker"` → `type: "stage"`, `type: "classifier"` → `type: "stage"`, `type: "gate"` → `type: "stage"` (or `fan_in` if it was acting as a sync point), `type: "parallel_fan_out"` → `type: "fan_out"`.

Replace `when: "stages.x.output.decision == 'approved'"` → `sourceHandle: "approved"`.

- [ ] **Step 2: Run full test suite**

Run: `pnpm --filter pipeline-engine exec vitest run`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/pipeline-engine/src/tests/
git commit -m "test(pipeline-engine): update all tests for new node types and decision routing"
```

---

### Task 12: Clean up expression engine (optional)

**Files:**
- Modify: `packages/plugins/pipeline-engine/src/expression-engine.ts`

- [ ] **Step 1: Remove `evaluateCondition` and `buildEdgeExpressionContext` exports**

The expression engine uses jsonata and exports:
- `evaluateCondition(expression, context)` — used only by `when` condition evaluation in the router → **REMOVE**
- `buildEdgeExpressionContext()` — builds context for edge condition evaluation → **REMOVE**
- `buildExpressionContext()` — builds context for template/expression rendering → **KEEP** (still used by template engine)

The module itself (jsonata dependency, security blocklist) must remain because it's still used for template string evaluation elsewhere.

- [ ] **Step 2: Remove dead code — only the condition-related functions**

- [ ] **Step 3: Run tests**

Run: `pnpm --filter pipeline-engine exec vitest run`

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/pipeline-engine/src/expression-engine.ts
git commit -m "refactor(pipeline-engine): remove unused condition evaluation from expression engine"
```

---

## Execution Order Summary

1. **Task 1** — Types (everything else depends on this)
2. **Task 2** — Schemas (needed by Task 3)
3. **Task 3** — Schema utils (needed by Tasks 7, 9)
4. **Task 4** — Router update (backend, independent of UI)
5. **Task 10** — Data handler in worker.ts (needed by Task 7 at runtime, move before UI work)
6. **Tasks 5-6** — UI palette and node rendering
7. **Task 7** — PipelineCanvas wiring (depends on Tasks 3, 10)
8. **Task 8** — Inspector (depends on Task 5 for types)
9. **Task 9** — Validation (depends on Tasks 7, 3)
10. **Task 11** — Test cleanup (last)
11. **Task 12** — Expression engine cleanup (optional, last)

### Parallelization opportunities
- Tasks 4 and 10 are independent of each other and can run in parallel after Task 3
- Tasks 5 and 6 are sequential but independent of Tasks 4/10
