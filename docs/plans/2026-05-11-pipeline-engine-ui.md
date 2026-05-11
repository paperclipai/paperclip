# Pipeline Engine UI — Implementation Plan

> **For agentic workers:** REQUIRED: Use forge:subagent-driven-development (if subagents available) or forge:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement an n8n-style visual UI for the pipeline-engine plugin with edge-based routing, full CRUD, execution replay, and dashboard metrics.

**Architecture:** Three-phase build — (1) refactor engine internals from `depends_on` to edge-based routing, (2) register data/action/stream handlers for the UI bridge, (3) build ReactFlow canvas with pipeline builder, run replay, and dashboard widget. All changes are in `packages/plugins/pipeline-engine/`.

**Tech Stack:** TypeScript, React, @xyflow/react (ReactFlow), dagre, esbuild, vitest, @paperclipai/plugin-sdk

**Verification Criteria:**
- [ ] Engine correctly routes via edges (all existing + new router tests pass)
- [ ] Pipelines stored as JSON with edges/positions (no YAML)
- [ ] UI renders in all 4 slot surfaces (page, detailTab, sidebar, dashboardWidget)
- [ ] Pipeline CRUD via visual builder works end-to-end
- [ ] Execution replay shows per-stage status with live updates
- [ ] Cancel run marks stages as skipped and run as cancelled
- [ ] Dashboard widget shows active/stuck/completed counts

---

## File Structure

### Files to create:

| Path | Responsibility |
|------|----------------|
| `src/ui/index.tsx` | Slot exports (PipelinesPage, PipelineRunsTab, PipelinesSidebar, PipelineHealthWidget) |
| `src/ui/constants.ts` | DATA_KEYS, ACTION_KEYS, STREAM_CHANNELS string constants |
| `src/ui/components/PipelineCanvas.tsx` | ReactFlow canvas with three-panel layout |
| `src/ui/components/StageNode.tsx` | Custom ReactFlow node renderer (type colors, badges, status borders) |
| `src/ui/components/StagePalette.tsx` | Left panel with draggable stage type cards |
| `src/ui/components/StageInspector.tsx` | Right panel context-sensitive form |
| `src/ui/components/PipelineList.tsx` | Pipeline list/management table view |
| `src/ui/components/RunReplayCanvas.tsx` | Read-only execution canvas with status overlays |
| `src/ui/components/RunHistory.tsx` | Run list with status badges |
| `src/ui/components/DashboardWidget.tsx` | Health metrics (active/stuck/completed) |
| `src/ui/hooks/useAutoLayout.ts` | Dagre-based auto-layout for pipeline graphs |
| `src/edge-utils.ts` | Pure functions: `getIncomingEdges`, `getOutgoingEdges`, `buildAdjacencyFromEdges` |
| `src/tests/edge-utils.test.ts` | Unit tests for edge utility functions |
| `src/tests/router-edge-based.test.ts` | Tests for the rewritten edge-based router |
| `src/tests/data-handlers.test.ts` | Tests for data/action handlers |
| `scripts/build-ui.mjs` | esbuild config for UI bundle |
| `migrations/002_add_cancelled_status.sql` | (Optional) Index for cancelled status — not strictly required since column is TEXT |

### Files to modify:

| Path | Changes |
|------|---------|
| `src/types.ts` | Add `EdgeDefinition`, add `edges`/`positions` to `PipelineDefinition`, add `"cancelled"` to `PipelineRunStatus`, remove `depends_on`/`condition`/`skip_if`/`on_failure` from `BaseStage`, add `retry` to stage types, remove `stages` from `ParallelFanOutStage` |
| `src/router.ts` | Rewrite `getReadyStages`/`getSkippedStages`/`evaluateFailure` for edge-based traversal |
| `src/dag-parser.ts` | Replace YAML parsing with JSON parsing + edge validation |
| `src/worker.ts` | Add `ctx.data.register`/`ctx.actions.register`/`ctx.streams.emit`, rewrite `buildStageContext`/`handleCheckpointCompletion`/`handleStageFailure` for edges, update `loadPipelines` key format |
| `src/state-machine.ts` | Add `listRuns`, `cancelRun` methods |
| `src/manifest.ts` | Add `entrypoints.ui`, `ui.slots[]`, new capabilities, remove `pipelines_dir`, update description |
| `src/expression-engine.ts` | Add `buildEdgeExpressionContext` (source stage output focused) |
| `package.json` | Add `@xyflow/react`, `dagre`, `@types/dagre`; remove `js-yaml`, `@types/js-yaml`; add `build:ui` script |

---

## Chunk 1: Engine Refactoring (Types + Edge Utils + Router)

### Task 1: Update type definitions

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Write new types inline**

Replace the content of `src/types.ts` with edge-based types:

```typescript
export type PipelineRunStatus = "running" | "paused" | "completed" | "failed" | "escalated" | "cancelled";

export type StageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type StageType = "worker" | "classifier" | "parallel_fan_out" | "gate" | "sub-pipeline";

export type FanInStrategy = "all_complete" | "first_complete";

export interface StageRetry {
  max_retries: number;
  body?: string;
}

interface BaseStage {
  id: string;
  type: StageType;
  timeout?: string;
  checkpoint?: boolean;
  retry?: StageRetry;
}

export interface WorkerStage extends BaseStage {
  type: "worker";
  agent_role: string;
  output_schema?: string;
  fan_in?: FanInStrategy;
  per_task?: boolean;
  ordering?: string;
}

export interface ClassifierStage extends BaseStage {
  type: "classifier";
  agent_role: string;
  output_schema?: string;
}

export interface ParallelFanOutStage extends BaseStage {
  type: "parallel_fan_out";
  agent_role?: string;
  fan_in?: FanInStrategy;
  per_task?: boolean;
  ordering?: string;
}

export interface GateStage extends BaseStage {
  type: "gate";
  fan_in?: FanInStrategy;
  requires_approval?: boolean;
}

export interface SubPipelineStage extends BaseStage {
  type: "sub-pipeline";
  pipeline: string;
  per_task?: boolean;
  ordering?: string;
}

export type StageDefinition = WorkerStage | ClassifierStage | ParallelFanOutStage | GateStage | SubPipelineStage;

export interface EdgeDefinition {
  id: string;
  from: string;
  to: string;
  type?: "default" | "error";
  when?: string;
  label?: string;
}

export interface PipelineTrigger {
  label: string;
}

export interface PipelineDefinition {
  name: string;
  description: string;
  trigger: PipelineTrigger;
  stages: StageDefinition[];
  edges: EdgeDefinition[];
  positions: Record<string, { x: number; y: number }>;
}

// ... keep PipelineRun, PipelineStage, SubPipelineRun, RoleMapping,
// PipelineEngineConfig, StageOutput, ExpressionContext, DispatchRequest,
// ParsedOutput, FailureAction, CreateIssueInput, WakeupOptions unchanged
// except: remove pipelines_dir from PipelineEngineConfig
```

Key changes:
- Remove `depends_on`, `condition`, `skip_if`, `on_failure` from `BaseStage`
- Remove `stages?: StageDefinition[]` from `ParallelFanOutStage`
- Add `retry?: StageRetry` to `BaseStage`
- Add `EdgeDefinition` interface
- Add `edges` and `positions` to `PipelineDefinition`
- Add `"cancelled"` to `PipelineRunStatus`
- Remove `pipelines_dir` from `PipelineEngineConfig`

- [ ] **Step 2: Run typecheck to identify all downstream breakages**

Run: `cd packages/plugins/pipeline-engine && pnpm typecheck`
Expected: Multiple type errors in router.ts, worker.ts, dag-parser.ts, tests (this is expected — we fix them in subsequent tasks)

- [ ] **Step 3: Commit type changes**

```bash
git add packages/plugins/pipeline-engine/src/types.ts
git commit -m "refactor(pipeline-engine): update types to edge-based model"
```

---

### Task 2: Create edge utility functions

**Files:**
- Create: `src/edge-utils.ts`
- Create: `src/tests/edge-utils.test.ts`

- [ ] **Step 1: Write failing tests for edge utilities**

```typescript
// src/tests/edge-utils.test.ts
import { describe, it, expect } from "vitest";
import {
  getIncomingEdges,
  getOutgoingEdges,
  getForwardEdges,
  getErrorEdges,
  buildAdjacencyFromEdges,
  getRootStageIds,
} from "../edge-utils.js";
import type { EdgeDefinition } from "../types.js";

const edges: EdgeDefinition[] = [
  { id: "e1", from: "a", to: "b" },
  { id: "e2", from: "a", to: "c", when: "output.type == 'bug'" },
  { id: "e3", from: "b", to: "d" },
  { id: "e4", from: "c", to: "d" },
  { id: "e5", from: "d", to: "b", type: "error" },
];

describe("getIncomingEdges", () => {
  it("returns forward edges targeting a stage", () => {
    const incoming = getIncomingEdges("d", edges);
    expect(incoming).toHaveLength(2);
    expect(incoming.map((e) => e.from)).toEqual(["b", "c"]);
  });

  it("returns empty for root stages", () => {
    expect(getIncomingEdges("a", edges)).toHaveLength(0);
  });
});

describe("getOutgoingEdges", () => {
  it("returns all edges from a stage", () => {
    const outgoing = getOutgoingEdges("a", edges);
    expect(outgoing).toHaveLength(2);
  });
});

describe("getForwardEdges", () => {
  it("excludes error edges", () => {
    const forward = getForwardEdges(edges);
    expect(forward).toHaveLength(4);
    expect(forward.every((e) => e.type !== "error")).toBe(true);
  });
});

describe("getErrorEdges", () => {
  it("returns only error edges", () => {
    const errors = getErrorEdges(edges);
    expect(errors).toHaveLength(1);
    expect(errors[0].id).toBe("e5");
  });
});

describe("buildAdjacencyFromEdges", () => {
  it("builds forward-only adjacency (from → to[]), excluding error edges", () => {
    const adj = buildAdjacencyFromEdges(edges);
    expect(adj.get("a")).toEqual(["b", "c"]);
    expect(adj.has("d")).toBe(false); // error edge excluded
  });
});

describe("getRootStageIds", () => {
  it("identifies stages with no incoming forward edges", () => {
    const stageIds = ["a", "b", "c", "d"];
    const roots = getRootStageIds(stageIds, edges);
    expect(roots).toEqual(["a"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/edge-utils.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement edge utilities**

```typescript
// src/edge-utils.ts
import type { EdgeDefinition } from "./types.js";

export function getIncomingEdges(stageId: string, edges: EdgeDefinition[]): EdgeDefinition[] {
  return edges.filter((e) => e.to === stageId && e.type !== "error");
}

export function getOutgoingEdges(stageId: string, edges: EdgeDefinition[]): EdgeDefinition[] {
  return edges.filter((e) => e.from === stageId);
}

export function getForwardEdges(edges: EdgeDefinition[]): EdgeDefinition[] {
  return edges.filter((e) => e.type !== "error");
}

export function getErrorEdges(edges: EdgeDefinition[]): EdgeDefinition[] {
  return edges.filter((e) => e.type === "error");
}

export function buildAdjacencyFromEdges(edges: EdgeDefinition[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.type === "error") continue;
    const targets = adj.get(edge.from) ?? [];
    targets.push(edge.to);
    adj.set(edge.from, targets);
  }
  return adj;
}

export function getRootStageIds(stageIds: string[], edges: EdgeDefinition[]): string[] {
  const hasIncoming = new Set(edges.filter((e) => e.type !== "error").map((e) => e.to));
  return stageIds.filter((id) => !hasIncoming.has(id));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/edge-utils.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pipeline-engine/src/edge-utils.ts packages/plugins/pipeline-engine/src/tests/edge-utils.test.ts
git commit -m "feat(pipeline-engine): add edge utility functions"
```

---

### Task 3: Rewrite dag-parser for JSON + edge validation

**Files:**
- Modify: `src/dag-parser.ts`
- Modify: `src/tests/dag-parser.test.ts`

- [ ] **Step 1: Rewrite dag-parser.ts**

Replace YAML parsing with JSON:

```typescript
// src/dag-parser.ts
import type { PipelineDefinition } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function parsePipeline(content: string): PipelineDefinition {
  const parsed = JSON.parse(content);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid pipeline: expected a JSON object");
  }
  if (!parsed.name || typeof parsed.name !== "string") {
    throw new Error("Pipeline must have a 'name' field");
  }
  if (!parsed.trigger || typeof parsed.trigger !== "object") {
    throw new Error("Pipeline must have a 'trigger' field");
  }
  if (!Array.isArray(parsed.stages) || parsed.stages.length === 0) {
    throw new Error("Pipeline must have at least one stage");
  }
  if (!Array.isArray(parsed.edges)) {
    throw new Error("Pipeline must have an 'edges' array");
  }

  return {
    name: parsed.name,
    description: parsed.description ?? "",
    trigger: parsed.trigger,
    stages: parsed.stages,
    edges: parsed.edges,
    positions: parsed.positions ?? {},
  };
}

export function validateDAG(pipeline: PipelineDefinition): ValidationResult {
  const errors: string[] = [];
  const stageIds = new Set<string>();

  for (const stage of pipeline.stages) {
    if (stageIds.has(stage.id)) {
      errors.push(`duplicate stage id: "${stage.id}"`);
    }
    stageIds.add(stage.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of pipeline.edges) {
    if (edgeIds.has(edge.id)) {
      errors.push(`duplicate edge id: "${edge.id}"`);
    }
    edgeIds.add(edge.id);

    if (!stageIds.has(edge.from)) {
      errors.push(`edge "${edge.id}" references nonexistent source stage "${edge.from}"`);
    }
    if (!stageIds.has(edge.to)) {
      errors.push(`edge "${edge.id}" references nonexistent target stage "${edge.to}"`);
    }
  }

  const cycleError = detectCycle(pipeline);
  if (cycleError) {
    errors.push(cycleError);
  }

  return { valid: errors.length === 0, errors };
}

function detectCycle(pipeline: PipelineDefinition): string | null {
  const forwardEdges = pipeline.edges.filter((e) => e.type !== "error");
  const adjacency = new Map<string, string[]>();
  for (const stage of pipeline.stages) {
    adjacency.set(stage.id, []);
  }
  for (const edge of forwardEdges) {
    adjacency.get(edge.from)?.push(edge.to);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    inStack.add(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      if (dfs(next)) return true;
    }
    inStack.delete(nodeId);
    return false;
  }

  for (const stage of pipeline.stages) {
    if (dfs(stage.id)) {
      return `cycle detected involving stage "${stage.id}"`;
    }
  }
  return null;
}
```

- [ ] **Step 2: Update dag-parser tests**

Rewrite `src/tests/dag-parser.test.ts` to use JSON input with edges instead of YAML with depends_on. Key test cases:
- Valid pipeline JSON parses correctly
- Missing edges array throws
- Duplicate edge IDs detected
- Dangling edge references detected
- Cycle detection still works (via forward edges)
- Error edges excluded from cycle detection

- [ ] **Step 3: Run tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/dag-parser.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/pipeline-engine/src/dag-parser.ts packages/plugins/pipeline-engine/src/tests/dag-parser.test.ts
git commit -m "refactor(pipeline-engine): rewrite dag-parser for JSON + edge validation"
```

---

### Task 4: Add edge expression context helper

**Files:**
- Modify: `src/expression-engine.ts`
- Modify: `src/tests/expression-engine.test.ts`

- [ ] **Step 1: Add buildEdgeExpressionContext function**

Add to `expression-engine.ts`:

```typescript
export function buildEdgeExpressionContext(
  sourceStageId: string,
  stages: Pick<PipelineStage, "stageId" | "status" | "output" | "retryCount">[],
  pipelineName: string,
  pipelineVersion: number,
  parentIssueId: string,
  companyId: string,
): ExpressionContext {
  const fullContext = buildExpressionContext(stages, pipelineName, pipelineVersion, parentIssueId, companyId);
  const sourceEntry = fullContext.stages[sourceStageId] ?? fullContext.stages[sourceStageId.replace(/-/g, "_")];
  return {
    ...fullContext,
    output: sourceEntry?.output ?? null,
  };
}
```

This puts source stage output at top-level `output` for ergonomic edge expressions like `output.type == 'feature'`, while still providing full `stages.*` access.

- [ ] **Step 2: Add test for edge expression context**

```typescript
it("buildEdgeExpressionContext places source output at top level", () => {
  const stages = [
    { stageId: "classify", status: "completed" as const, output: { type: "feature" }, retryCount: 0 },
    { stageId: "other", status: "pending" as const, output: null, retryCount: 0 },
  ];
  const ctx = buildEdgeExpressionContext("classify", stages, "test", 1, "issue-1", "company-1");
  expect(ctx.output).toEqual({ type: "feature" });
  expect(ctx.stages.classify.output).toEqual({ type: "feature" });
});
```

- [ ] **Step 3: Run tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/expression-engine.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/pipeline-engine/src/expression-engine.ts packages/plugins/pipeline-engine/src/tests/expression-engine.test.ts
git commit -m "feat(pipeline-engine): add edge expression context builder"
```

---

### Task 5: Rewrite router for edge-based traversal

**Files:**
- Modify: `src/router.ts`
- Create: `src/tests/router-edge-based.test.ts`

- [ ] **Step 1: Write failing tests for edge-based router**

```typescript
// src/tests/router-edge-based.test.ts
import { describe, it, expect } from "vitest";
import { Router } from "../router.js";
import type { PipelineDefinition, PipelineStage, EdgeDefinition, StageDefinition } from "../types.js";

function makeStageRow(overrides: Partial<PipelineStage> & { stageId: string }): PipelineStage {
  return {
    id: `row-${overrides.stageId}`,
    pipelineRunId: "run-1",
    subIssueId: null,
    status: "pending",
    retryCount: 0,
    output: null,
    error: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function makePipeline(stages: StageDefinition[], edges: EdgeDefinition[]): PipelineDefinition {
  return {
    name: "test",
    description: "",
    trigger: { label: "test" },
    stages,
    edges,
    positions: {},
  };
}

describe("Router (edge-based)", () => {
  const router = new Router();

  describe("getReadyStages", () => {
    it("root stages (no incoming edges) are ready immediately", async () => {
      const pipeline = makePipeline(
        [{ id: "a", type: "worker", agent_role: "dev" }],
        [],
      );
      const rows = [makeStageRow({ stageId: "a" })];
      const ready = await router.getReadyStages(pipeline, rows, "c1");
      expect(ready.map((s) => s.id)).toEqual(["a"]);
    });

    it("stage is ready when all incoming forward edge sources are completed", async () => {
      const pipeline = makePipeline(
        [
          { id: "a", type: "worker", agent_role: "dev" },
          { id: "b", type: "worker", agent_role: "dev" },
          { id: "c", type: "worker", agent_role: "dev" },
        ],
        [
          { id: "e1", from: "a", to: "c" },
          { id: "e2", from: "b", to: "c" },
        ],
      );
      const rows = [
        makeStageRow({ stageId: "a", status: "completed" }),
        makeStageRow({ stageId: "b", status: "completed" }),
        makeStageRow({ stageId: "c" }),
      ];
      const ready = await router.getReadyStages(pipeline, rows, "c1");
      expect(ready.map((s) => s.id)).toEqual(["c"]);
    });

    it("stage not ready if any incoming source is not completed", async () => {
      const pipeline = makePipeline(
        [
          { id: "a", type: "worker", agent_role: "dev" },
          { id: "b", type: "worker", agent_role: "dev" },
          { id: "c", type: "worker", agent_role: "dev" },
        ],
        [
          { id: "e1", from: "a", to: "c" },
          { id: "e2", from: "b", to: "c" },
        ],
      );
      const rows = [
        makeStageRow({ stageId: "a", status: "completed" }),
        makeStageRow({ stageId: "b", status: "running" }),
        makeStageRow({ stageId: "c" }),
      ];
      const ready = await router.getReadyStages(pipeline, rows, "c1");
      expect(ready).toHaveLength(0);
    });

    it("conditional edge: stage ready only if when condition is true", async () => {
      const pipeline = makePipeline(
        [
          { id: "classify", type: "classifier", agent_role: "arch" },
          { id: "feature", type: "worker", agent_role: "dev" },
          { id: "bug", type: "worker", agent_role: "dev" },
        ],
        [
          { id: "e1", from: "classify", to: "feature", when: "output.type = 'feature'" },
          { id: "e2", from: "classify", to: "bug", when: "output.type = 'bug'" },
        ],
      );
      const rows = [
        makeStageRow({ stageId: "classify", status: "completed", output: { type: "feature" } }),
        makeStageRow({ stageId: "feature" }),
        makeStageRow({ stageId: "bug" }),
      ];
      const ready = await router.getReadyStages(pipeline, rows, "c1");
      expect(ready.map((s) => s.id)).toEqual(["feature"]);
    });

    it("fan_in first_complete: stage ready when any source completes", async () => {
      const pipeline = makePipeline(
        [
          { id: "a", type: "worker", agent_role: "dev" },
          { id: "b", type: "worker", agent_role: "dev" },
          { id: "c", type: "gate", fan_in: "first_complete" },
        ],
        [
          { id: "e1", from: "a", to: "c" },
          { id: "e2", from: "b", to: "c" },
        ],
      );
      const rows = [
        makeStageRow({ stageId: "a", status: "completed" }),
        makeStageRow({ stageId: "b", status: "running" }),
        makeStageRow({ stageId: "c" }),
      ];
      const ready = await router.getReadyStages(pipeline, rows, "c1");
      expect(ready.map((s) => s.id)).toEqual(["c"]);
    });

    it("sub-pipeline stages are skipped", async () => {
      const pipeline = makePipeline(
        [{ id: "sub", type: "sub-pipeline", pipeline: "other" }],
        [],
      );
      const rows = [makeStageRow({ stageId: "sub" })];
      const ready = await router.getReadyStages(pipeline, rows, "c1");
      expect(ready).toHaveLength(0);
    });
  });

  describe("getSkippedStages", () => {
    it("marks stages reachable only via false-condition edges as skipped", async () => {
      const pipeline = makePipeline(
        [
          { id: "classify", type: "classifier", agent_role: "arch" },
          { id: "feature", type: "worker", agent_role: "dev" },
          { id: "bug", type: "worker", agent_role: "dev" },
        ],
        [
          { id: "e1", from: "classify", to: "feature", when: "output.type = 'feature'" },
          { id: "e2", from: "classify", to: "bug", when: "output.type = 'bug'" },
        ],
      );
      const rows = [
        makeStageRow({ stageId: "classify", status: "completed", output: { type: "feature" } }),
        makeStageRow({ stageId: "feature" }),
        makeStageRow({ stageId: "bug" }),
      ];
      const skipped = await router.getSkippedStages(pipeline, rows, "c1");
      expect(skipped.map((s) => s.id)).toEqual(["bug"]);
    });
  });

  describe("evaluateFailure", () => {
    it("returns error edge target as retry destination", () => {
      const pipeline = makePipeline(
        [
          { id: "impl", type: "worker", agent_role: "dev", retry: { max_retries: 2, body: "Fix: {{output.issues}}" } },
          { id: "validate", type: "worker", agent_role: "val" },
        ],
        [
          { id: "e1", from: "impl", to: "validate" },
          { id: "e2", from: "validate", to: "impl", type: "error" },
        ],
      );
      const stageRow = makeStageRow({ stageId: "validate", status: "failed", output: { issues: "broken" } });
      const result = router.evaluateFailure(pipeline, "validate", stageRow, stageRow);
      expect(result.action).toBe("goto");
      if (result.action === "goto") {
        expect(result.targetStageId).toBe("impl");
      }
    });

    it("escalates when no error edge exists", () => {
      const pipeline = makePipeline(
        [{ id: "impl", type: "worker", agent_role: "dev" }],
        [],
      );
      const stageRow = makeStageRow({ stageId: "impl", status: "failed" });
      const result = router.evaluateFailure(pipeline, "impl", stageRow, stageRow);
      expect(result.action).toBe("escalate");
    });

    it("escalates when retry count exceeds max", () => {
      const pipeline = makePipeline(
        [
          { id: "impl", type: "worker", agent_role: "dev", retry: { max_retries: 1 } },
          { id: "validate", type: "worker", agent_role: "val" },
        ],
        [{ id: "e1", from: "validate", to: "impl", type: "error" }],
      );
      const targetRow = makeStageRow({ stageId: "impl", retryCount: 1 });
      const stageRow = makeStageRow({ stageId: "validate", status: "failed" });
      const result = router.evaluateFailure(pipeline, "validate", stageRow, targetRow);
      expect(result.action).toBe("escalate");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/router-edge-based.test.ts`
Expected: FAIL (Router API doesn't match yet)

- [ ] **Step 3: Rewrite router.ts**

```typescript
// src/router.ts
import { evaluateCondition, buildEdgeExpressionContext } from "./expression-engine.js";
import { renderTemplate } from "./template-engine.js";
import { getIncomingEdges, getErrorEdges } from "./edge-utils.js";
import type { EdgeDefinition, FailureAction, PipelineDefinition, PipelineStage, StageDefinition } from "./types.js";

export class Router {
  async getReadyStages(
    pipeline: PipelineDefinition,
    stageRows: PipelineStage[],
    companyId: string,
  ): Promise<StageDefinition[]> {
    const statusMap = new Map(stageRows.map((s) => [s.stageId, s]));
    const ready: StageDefinition[] = [];

    for (const stageDef of pipeline.stages) {
      const row = statusMap.get(stageDef.id);
      if (!row || row.status !== "pending") continue;
      if (stageDef.type === "sub-pipeline") continue;

      const incoming = getIncomingEdges(stageDef.id, pipeline.edges);

      // Root stage: no incoming forward edges → ready immediately
      if (incoming.length === 0) {
        ready.push(stageDef);
        continue;
      }

      const useFanInFirst = "fan_in" in stageDef && stageDef.fan_in === "first_complete";

      let isReady: boolean;
      if (useFanInFirst) {
        isReady = await this.anyEdgeSatisfied(incoming, statusMap, stageRows, pipeline, companyId);
      } else {
        isReady = await this.allEdgesSatisfied(incoming, statusMap, stageRows, pipeline, companyId);
      }

      if (isReady) ready.push(stageDef);
    }

    return ready;
  }

  async getSkippedStages(
    pipeline: PipelineDefinition,
    stageRows: PipelineStage[],
    companyId: string,
  ): Promise<StageDefinition[]> {
    const statusMap = new Map(stageRows.map((s) => [s.stageId, s]));
    const skipped: StageDefinition[] = [];

    for (const stageDef of pipeline.stages) {
      const row = statusMap.get(stageDef.id);
      if (!row || row.status !== "pending") continue;

      const incoming = getIncomingEdges(stageDef.id, pipeline.edges);
      if (incoming.length === 0) continue;

      // All incoming edges must have completed sources
      const allSourcesResolved = incoming.every((edge) => {
        const sourceRow = statusMap.get(edge.from);
        return sourceRow?.status === "completed" || sourceRow?.status === "skipped";
      });
      if (!allSourcesResolved) continue;

      // Check if ALL conditional edges evaluate false
      const conditionalEdges = incoming.filter((e) => e.when);
      if (conditionalEdges.length === 0) continue;

      let anyTrue = false;
      for (const edge of conditionalEdges) {
        const sourceRow = statusMap.get(edge.from);
        if (sourceRow?.status !== "completed") continue;
        const ctx = buildEdgeExpressionContext(
          edge.from, stageRows, pipeline.name, 1, "", companyId,
        );
        const result = await evaluateCondition(edge.when!, ctx);
        if (result) { anyTrue = true; break; }
      }

      // Also check unconditional edges with completed sources
      const unconditionalCompleted = incoming.filter((e) => !e.when).some((edge) => {
        const sourceRow = statusMap.get(edge.from);
        return sourceRow?.status === "completed";
      });

      if (!anyTrue && !unconditionalCompleted) {
        skipped.push(stageDef);
      }
    }

    return skipped;
  }

  evaluateFailure(
    pipeline: PipelineDefinition,
    failedStageId: string,
    stageRow: PipelineStage,
    targetStageRow: PipelineStage,
  ): FailureAction {
    const errorEdges = getErrorEdges(pipeline.edges).filter((e) => e.from === failedStageId);
    if (errorEdges.length === 0) return { action: "escalate" };

    const targetEdge = errorEdges[0];
    const targetStageDef = pipeline.stages.find((s) => s.id === targetEdge.to);
    if (!targetStageDef?.retry) return { action: "escalate" };

    const { max_retries, body } = targetStageDef.retry;
    if (targetStageRow.retryCount >= max_retries) return { action: "escalate" };

    let renderedBody = body ?? "";
    if (body) {
      try {
        renderedBody = renderTemplate(body, { output: stageRow.output ?? {} });
      } catch {
        renderedBody = body;
      }
    }

    return { action: "goto", targetStageId: targetEdge.to, body: renderedBody };
  }

  requiresAgentDispatch(stageDef: StageDefinition): boolean {
    return stageDef.type === "worker" || stageDef.type === "classifier" || stageDef.type === "parallel_fan_out";
  }

  private async allEdgesSatisfied(
    edges: EdgeDefinition[],
    statusMap: Map<string, PipelineStage>,
    stageRows: PipelineStage[],
    pipeline: PipelineDefinition,
    companyId: string,
  ): Promise<boolean> {
    for (const edge of edges) {
      const sourceRow = statusMap.get(edge.from);
      if (sourceRow?.status !== "completed") return false;

      if (edge.when) {
        const ctx = buildEdgeExpressionContext(
          edge.from, stageRows, pipeline.name, 1, "", companyId,
        );
        const result = await evaluateCondition(edge.when, ctx);
        if (!result) return false;
      }
    }
    return true;
  }

  private async anyEdgeSatisfied(
    edges: EdgeDefinition[],
    statusMap: Map<string, PipelineStage>,
    stageRows: PipelineStage[],
    pipeline: PipelineDefinition,
    companyId: string,
  ): Promise<boolean> {
    for (const edge of edges) {
      const sourceRow = statusMap.get(edge.from);
      if (sourceRow?.status !== "completed") continue;

      if (edge.when) {
        const ctx = buildEdgeExpressionContext(
          edge.from, stageRows, pipeline.name, 1, "", companyId,
        );
        const result = await evaluateCondition(edge.when, ctx);
        if (result) return true;
      } else {
        return true;
      }
    }
    return false;
  }
}
```

- [ ] **Step 4: Run edge-based router tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/router-edge-based.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Remove old router tests, rename new ones**

Delete or replace `src/tests/router.test.ts` with the edge-based version.

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/pipeline-engine/src/router.ts packages/plugins/pipeline-engine/src/tests/
git commit -m "refactor(pipeline-engine): rewrite router for edge-based traversal"
```

---

### Task 6: Update StateMachine (listRuns + cancelRun)

**Files:**
- Modify: `src/state-machine.ts`
- Modify: `src/tests/state-machine.test.ts`

- [ ] **Step 1: Add listRuns and cancelRun methods**

Add to `StateMachine` class:

```typescript
async listRuns(companyId: string, opts?: { issueId?: string; status?: PipelineRunStatus; limit?: number }): Promise<PipelineRun[]> {
  const conditions = ["company_id = $1"];
  const params: unknown[] = [companyId];
  let paramIndex = 2;

  if (opts?.issueId) {
    conditions.push(`parent_issue_id = $${paramIndex++}`);
    params.push(opts.issueId);
  }
  if (opts?.status) {
    conditions.push(`status = $${paramIndex++}`);
    params.push(opts.status);
  }

  const limit = opts?.limit ?? 50;
  const sql = `SELECT * FROM ${this.table("pipeline_runs")} WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ${limit}`;
  const rows = await this.db.query<{
    id: string; company_id: string; parent_issue_id: string;
    pipeline_name: string; pipeline_version: number; pipeline_yaml: string;
    status: PipelineRunStatus; created_at: string; updated_at: string;
  }>(sql, params);

  return rows.map((r) => ({
    id: r.id,
    companyId: r.company_id,
    parentIssueId: r.parent_issue_id,
    pipelineName: r.pipeline_name,
    pipelineVersion: r.pipeline_version,
    pipelineYaml: r.pipeline_yaml,
    status: r.status,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  }));
}

async cancelRun(runId: string): Promise<void> {
  await this.db.execute(
    `UPDATE ${this.table("pipeline_runs")} SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
    [runId],
  );
  await this.db.execute(
    `UPDATE ${this.table("pipeline_stages")} SET status = 'skipped', completed_at = NOW()
     WHERE pipeline_run_id = $1 AND status IN ('pending', 'running')`,
    [runId],
  );
  this.activeLocks.delete(runId);
}
```

- [ ] **Step 2: Add tests for new methods**

Add to `src/tests/state-machine.test.ts` tests verifying:
- `listRuns` returns runs filtered by companyId/issueId/status
- `cancelRun` sets run to cancelled, pending/running stages to skipped, releases lock

- [ ] **Step 3: Run tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/state-machine.test.ts`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/pipeline-engine/src/state-machine.ts packages/plugins/pipeline-engine/src/tests/state-machine.test.ts
git commit -m "feat(pipeline-engine): add listRuns and cancelRun to StateMachine"
```

---

### Task 7: Rewrite worker.ts for edge-based logic

**Files:**
- Modify: `src/worker.ts`

- [ ] **Step 1: Rewrite loadPipelines to scan all pipeline state keys**

The current implementation iterates `config.trigger_labels` to know which pipelines to load. This breaks when pipelines are saved via the UI without updating config. Rewrite to scan all `pipeline:*` state keys directly:

```typescript
async function loadPipelines(ctx: PluginContext): Promise<PipelineDefinition[]> {
  const keys = await ctx.state.list({ scopeKind: "instance", namespace: "pipeline", prefix: "pipeline:" });
  const loaded: PipelineDefinition[] = [];

  for (const key of keys) {
    const jsonContent = await ctx.state.get({ scopeKind: "instance", namespace: "pipeline", stateKey: key });
    if (!jsonContent) continue;
    try {
      const pipeline = parsePipeline(jsonContent as string);
      const validation = validateDAG(pipeline);
      if (validation.valid) {
        loaded.push(pipeline);
      } else {
        ctx.logger.warn("Invalid pipeline definition", { key, errors: validation.errors });
      }
    } catch (err) {
      ctx.logger.warn("Failed to parse pipeline", { key, error: String(err) });
    }
  }

  return loaded;
}
```

> **Note:** If `ctx.state.list()` does not support a `prefix` filter, use `ctx.state.list({ scopeKind: "instance", namespace: "pipeline" })` and filter keys client-side with `key.startsWith("pipeline:")`. Check the SDK's `PluginStateClient` type for available parameters.

- [ ] **Step 2: Rewrite buildStageContext to use edges**

```typescript
async function buildStageContext(
  ctx: PluginContext,
  parentIssueId: string,
  companyId: string,
  stageDef: StageDefinition,
  pipeline: PipelineDefinition,
  stageRows: Array<{ stageId: string; status: string; output: Record<string, unknown> | null }>,
): Promise<string> {
  const sections: string[] = [];

  const parentIssue = await ctx.issues.get(parentIssueId, companyId);
  if (parentIssue) {
    sections.push(`## Original Request\n\n**${parentIssue.title}**\n\n${parentIssue.description ?? ""}`);
  }

  // Find upstream stages via incoming edges
  const incomingEdges = pipeline.edges.filter((e) => e.to === stageDef.id && e.type !== "error");
  const upstreamIds = incomingEdges.map((e) => e.from);

  if (upstreamIds.length > 0) {
    const upstreamOutputs: string[] = [];
    for (const depId of upstreamIds) {
      const depRow = stageRows.find((s) => s.stageId === depId);
      if (depRow?.output) {
        upstreamOutputs.push(`### ${depId} output\n\n\`\`\`json\n${JSON.stringify(depRow.output, null, 2)}\n\`\`\``);
      }
    }
    if (upstreamOutputs.length > 0) {
      sections.push(`## Upstream Stage Results\n\n${upstreamOutputs.join("\n\n")}`);
    }
  }

  return sections.join("\n\n---\n\n");
}
```

Note: `buildStageContext` now takes `pipeline` as an argument. Update all call sites.

- [ ] **Step 3: Rewrite handleCheckpointCompletion to use edges**

```typescript
async function handleCheckpointCompletion(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  checkpointStageDef: StageDefinition,
  output: Record<string, unknown>,
  companyId: string,
): Promise<void> {
  ctx.logger.info("Checkpoint stage completed — dynamic downstream planning", {
    runId,
    stageId: checkpointStageDef.id,
    outputKeys: Object.keys(output),
  });

  // Find downstream stages via outgoing edges
  const outgoingEdges = pipeline.edges.filter((e) => e.from === checkpointStageDef.id && e.type !== "error");
  const downstreamIds = outgoingEdges.map((e) => e.to);
  const downstreamDefs = pipeline.stages.filter((s) => downstreamIds.includes(s.id));
  const hasSubPipelines = downstreamDefs.some((s) => s.type === "sub-pipeline");

  if (hasSubPipelines) {
    ctx.logger.warn("Sub-pipeline materialization not yet implemented — pipeline paused", { runId });
    await stateMachine.updateRunStatus(runId, "paused");
    return;
  }

  await advancePipeline(ctx, runId, pipeline, companyId);
}
```

- [ ] **Step 4: Rewrite handleStageFailure for edge-based routing**

This step involves multiple changes to `handleStageFailure`:

**4a. Remove the dead `on_failure` lookup.** Delete this block entirely (it references fields removed from types):
```typescript
// DELETE these lines:
const targetStageId = stageDef.on_failure?.retry_with?.goto;
const targetRow = targetStageId
  ? stageRows.find((s) => s.stageId === targetStageId)
  : undefined;
```

**4b. Update `evaluateFailure` call to use new router signature:**
```typescript
// The new router derives the retry target from the error edge internally
const failureAction = router.evaluateFailure(pipeline, stageDef.id, stageRow, stageRow);
```

**4c. Replace the adjacency construction for `resetDownstreamStages`:**

`resetDownstreamStages` → `getDownstreamStageIds` expects `adjacency.get(stageId)` = the stages that `stageId` depends on (its incoming sources). It walks forward by finding stages that list `current` in their deps. So we need `stageId → [source stages]`:

```typescript
// adjacency[stageId] = list of stages stageId depends on (incoming forward edges)
const allStageIds = pipeline.stages.map((s) => s.id);
const adjacency = new Map<string, string[]>();
for (const stage of pipeline.stages) {
  adjacency.set(stage.id, []);
}
for (const edge of pipeline.edges.filter((e) => e.type !== "error")) {
  const deps = adjacency.get(edge.to) ?? [];
  deps.push(edge.from);
  adjacency.set(edge.to, deps);
}

await stateMachine.resetDownstreamStages(runId, failureAction.targetStageId, allStageIds, adjacency);
```

**4d. Update the `targetRow` / `gotoTargetRow` lookup** to use `failureAction.targetStageId` (returned by the router) instead of the removed `on_failure` field.

- [ ] **Step 5: Remove `safeParsePipelineYaml` naming (rename to `safeParsePipelineJson`)**

Rename the function for clarity since it's now JSON:
```typescript
function safeParsePipelineJson(json: string): PipelineDefinition | null {
  try {
    return JSON.parse(json) as PipelineDefinition;
  } catch {
    return null;
  }
}
```

Update all references from `safeParsePipelineYaml` to `safeParsePipelineJson`.

- [ ] **Step 6: Run typecheck**

Run: `cd packages/plugins/pipeline-engine && pnpm typecheck`
Expected: PASS (or only remaining errors from tests that still reference old types)

- [ ] **Step 7: Run all tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test`
Expected: Tests that reference old `depends_on` format will fail (integration tests). Fix those in the next step.

- [ ] **Step 8: Update integration and remaining tests for edge format**

Update `src/tests/integration.test.ts` and any other tests that construct pipelines with `depends_on` to use the new `edges` format.

- [ ] **Step 9: Run full test suite**

Run: `cd packages/plugins/pipeline-engine && pnpm test`
Expected: ALL PASS

- [ ] **Step 10: Commit**

```bash
git add packages/plugins/pipeline-engine/src/worker.ts packages/plugins/pipeline-engine/src/tests/
git commit -m "refactor(pipeline-engine): rewrite worker.ts for edge-based routing"
```

---

## Chunk 2: Backend Data/Action/Stream Handlers + Manifest

### Task 8: Update manifest

**Files:**
- Modify: `src/manifest.ts`

- [ ] **Step 1: Update manifest with UI declarations**

```typescript
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.pipeline-engine",
  apiVersion: 1,
  version: "0.2.0",
  displayName: "Pipeline Engine",
  description: "Deterministic pipeline engine for orchestrating agent work.",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "events.emit",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.relations.read",
    "issue.relations.write",
    "issue.documents.read",
    "issue.documents.write",
    "issue.subtree.read",
    "issue.comments.read",
    "issue.comments.create",
    "issues.wakeup",
    "issues.orchestration.read",
    "api.routes.register",
    "database.namespace.migrate",
    "database.namespace.read",
    "database.namespace.write",
    "plugin.state.read",
    "plugin.state.write",
    "agents.read",
    "ui.page.register",
    "ui.detailTab.register",
    "ui.sidebar.register",
    "ui.dashboardWidget.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      role_mapping: {
        type: "object",
        title: "Role to Agent Mapping",
        description: "Maps agent roles to agent UUIDs",
        additionalProperties: { type: "string" },
      },
      trigger_labels: {
        type: "object",
        title: "Trigger Label Mapping",
        description: "Maps label names to pipeline definition names",
        additionalProperties: { type: "string" },
      },
    },
    required: ["trigger_labels"],
  },
  apiRoutes: [
    { routeKey: "run-status", method: "GET", path: "/runs/:runId", auth: "board-or-agent", capability: "api.routes.register" },
    { routeKey: "pipelines", method: "GET", path: "/pipelines", auth: "board-or-agent", capability: "api.routes.register" },
  ],
  database: {
    namespaceSlug: "pipeline_engine",
    migrationsDir: "migrations",
    coreReadTables: ["issues"],
  },
  ui: {
    slots: [
      { type: "page", id: "pipelines-page", displayName: "Pipelines", exportName: "PipelinesPage", routePath: "pipelines" },
      { type: "detailTab", id: "pipeline-runs-tab", displayName: "Pipeline Runs", exportName: "PipelineRunsTab", entityTypes: ["issue"] },
      { type: "sidebar", id: "pipelines-sidebar", displayName: "Pipelines", exportName: "PipelinesSidebar" },
      { type: "dashboardWidget", id: "pipeline-health", displayName: "Pipeline Health", exportName: "PipelineHealthWidget" },
    ],
  },
};

export default manifest;
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/plugins/pipeline-engine && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/pipeline-engine/src/manifest.ts
git commit -m "feat(pipeline-engine): update manifest with UI slots and capabilities"
```

---

### Task 9: Register data/action/stream handlers in worker

**Files:**
- Modify: `src/worker.ts`
- Create: `src/tests/data-handlers.test.ts`

- [ ] **Step 1: Add data handlers to setup()**

Add inside the `setup(ctx)` function, after existing initialization:

```typescript
// Data handlers
ctx.data.register("list-pipelines", async (params) => {
  return pipelines.map((p) => ({
    name: p.name,
    description: p.description,
    trigger: p.trigger,
    stageCount: p.stages.length,
    edgeCount: p.edges.length,
  }));
});

ctx.data.register("get-pipeline", async (params) => {
  const { pipelineName } = params as { pipelineName: string };
  const pipeline = pipelines.find((p) => p.name === pipelineName);
  if (!pipeline) throw new Error(`Pipeline "${pipelineName}" not found`);
  return pipeline;
});

ctx.data.register("list-runs", async (params) => {
  const { companyId, issueId, status, limit } = params as {
    companyId: string; issueId?: string; status?: PipelineRunStatus; limit?: number;
  };
  return stateMachine.listRuns(companyId, { issueId, status, limit });
});

ctx.data.register("get-run", async (params) => {
  const { runId } = params as { runId: string };
  const run = await stateMachine.getRun(runId);
  if (!run) throw new Error(`Run "${runId}" not found`);
  const stages = await stateMachine.getRunStages(runId);
  const pipelineDef = safeParsePipelineJson(run.pipelineYaml);
  return { run, stages, pipelineDef };
});

ctx.data.register("list-agents", async (params) => {
  const { companyId } = params as { companyId: string };
  if (!ctx.agents) return [];
  return ctx.agents.list({ companyId });
});
```

- [ ] **Step 2: Add action handlers**

```typescript
// Action handlers
ctx.actions.register("save-pipeline", async (params) => {
  const { companyId, pipeline: pipelineDef } = params as { companyId: string; pipeline: PipelineDefinition };
  const validation = validateDAG(pipelineDef);
  if (!validation.valid) {
    throw new Error(`Invalid pipeline: ${validation.errors.join(", ")}`);
  }
  await ctx.state.set({
    scopeKind: "instance",
    namespace: "pipeline",
    stateKey: `pipeline:${pipelineDef.name}`,
  }, JSON.stringify(pipelineDef));

  // Reload in-memory state
  pipelines = await loadPipelines(ctx);
  triggerMatcher = new TriggerMatcher(pipelines);

  return { saved: true };
});

ctx.actions.register("delete-pipeline", async (params) => {
  const { pipelineName } = params as { pipelineName: string };
  await ctx.state.delete({
    scopeKind: "instance",
    namespace: "pipeline",
    stateKey: `pipeline:${pipelineName}`,
  });
  pipelines = await loadPipelines(ctx);
  triggerMatcher = new TriggerMatcher(pipelines);
  return { deleted: true };
});

ctx.actions.register("trigger-run", async (params) => {
  const { companyId, pipelineName, issueId } = params as { companyId: string; pipelineName: string; issueId: string };
  const pipeline = pipelines.find((p) => p.name === pipelineName);
  if (!pipeline) throw new Error(`Pipeline "${pipelineName}" not found`);
  await materializePipeline(ctx, pipeline, issueId, companyId);
  return { triggered: true };
});

ctx.actions.register("cancel-run", async (params) => {
  const { runId } = params as { runId: string };
  await stateMachine.cancelRun(runId);
  return { cancelled: true };
});
```

- [ ] **Step 3: Add stream emissions to advancePipeline and handleCommentEvent**

In `advancePipeline`, after each `stateMachine.updateStageStatus` call and after `stateMachine.claimStageForDispatch`, emit:

```typescript
ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "running" });
```

In `handleCommentEvent`, after stage completion:
```typescript
ctx.streams.emit("run-progress", { runId: stageRow.pipelineRunId, stageId: stageRow.stageId, status: "completed" });
```

On stage failure:
```typescript
ctx.streams.emit("run-progress", { runId: stageRow.pipelineRunId, stageId: stageRow.stageId, status: "failed", error: extraction.parseError });
```

- [ ] **Step 4: Write tests for data handlers**

Create `src/tests/data-handlers.test.ts` with mocked ctx testing:
- `list-pipelines` returns pipeline summaries
- `get-pipeline` returns full definition or throws
- `save-pipeline` validates and stores
- `cancel-run` delegates to StateMachine

- [ ] **Step 5: Run tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add packages/plugins/pipeline-engine/src/worker.ts packages/plugins/pipeline-engine/src/tests/data-handlers.test.ts
git commit -m "feat(pipeline-engine): register data/action/stream handlers for UI bridge"
```

---

### Task 10: Update package.json dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update dependencies**

Remove `js-yaml` and `@types/js-yaml`. Add UI dependencies:

```bash
cd packages/plugins/pipeline-engine && pnpm remove js-yaml @types/js-yaml && pnpm add @xyflow/react dagre && pnpm add -D @types/dagre
```

- [ ] **Step 2: Add build:ui script**

Add to `scripts` in `package.json`:
```json
"build:ui": "node ./scripts/build-ui.mjs"
```

Update `build` script:
```json
"build": "node ./esbuild.config.mjs && node ./scripts/build-ui.mjs"
```

- [ ] **Step 3: Create build-ui.mjs** (follows `plugin-kitchen-sink-example/scripts/build-ui.mjs` convention — spec mentions `esbuild.ui.config.mjs` but `scripts/` is the actual pattern)

```javascript
// scripts/build-ui.mjs
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/ui/index.tsx")],
  outfile: path.join(packageRoot, "dist/ui/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@paperclipai/plugin-sdk/ui",
  ],
  logLevel: "info",
});
```

- [ ] **Step 4: Run pnpm install**

Run: `cd packages/plugins/pipeline-engine && pnpm install`
Expected: lockfile updated

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pipeline-engine/package.json packages/plugins/pipeline-engine/scripts/build-ui.mjs pnpm-lock.yaml
git commit -m "feat(pipeline-engine): update deps (add xyflow/dagre, remove js-yaml) and add UI build"
```

---

## Chunk 3: UI Components

### Task 11: Create UI constants and slot exports

**Files:**
- Create: `src/ui/constants.ts`
- Create: `src/ui/index.tsx`

- [ ] **Step 1: Create constants**

```typescript
// src/ui/constants.ts
export const DATA_KEYS = {
  LIST_PIPELINES: "list-pipelines",
  GET_PIPELINE: "get-pipeline",
  LIST_RUNS: "list-runs",
  GET_RUN: "get-run",
  LIST_AGENTS: "list-agents",
} as const;

export const ACTION_KEYS = {
  SAVE_PIPELINE: "save-pipeline",
  DELETE_PIPELINE: "delete-pipeline",
  TRIGGER_RUN: "trigger-run",
  CANCEL_RUN: "cancel-run",
} as const;

export const STREAM_CHANNELS = {
  RUN_PROGRESS: "run-progress",
} as const;
```

- [ ] **Step 2: Create slot exports (index.tsx)**

```tsx
// src/ui/index.tsx
export { PipelinesPage } from "./components/PipelineList.js";
export { PipelineRunsTab } from "./components/RunHistory.js";
export { PipelinesSidebar } from "./components/PipelinesSidebar.js";
export { PipelineHealthWidget } from "./components/DashboardWidget.js";
```

Note: `PipelinesPage` will internally switch between list and builder views.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/
git commit -m "feat(pipeline-engine): add UI constants and slot entry point"
```

---

### Task 12: Create useAutoLayout hook

**Files:**
- Create: `src/ui/hooks/useAutoLayout.ts`

- [ ] **Step 1: Implement dagre auto-layout**

```typescript
// src/ui/hooks/useAutoLayout.ts
import dagre from "dagre";
import type { StageDefinition, EdgeDefinition } from "../../types.js";

interface LayoutResult {
  positions: Record<string, { x: number; y: number }>;
}

export function computeAutoLayout(
  stages: StageDefinition[],
  edges: EdgeDefinition[],
): LayoutResult {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 120 });

  for (const stage of stages) {
    g.setNode(stage.id, { width: 200, height: 90 });
  }
  for (const edge of edges) {
    if (edge.type !== "error") {
      g.setEdge(edge.from, edge.to);
    }
  }

  dagre.layout(g);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const stage of stages) {
    const node = g.node(stage.id);
    if (node) {
      positions[stage.id] = { x: node.x, y: node.y };
    }
  }

  return { positions };
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/hooks/
git commit -m "feat(pipeline-engine): add dagre auto-layout hook"
```

---

### Task 13: Create StageNode component

**Files:**
- Create: `src/ui/components/StageNode.tsx`

- [ ] **Step 1: Implement custom ReactFlow node**

```tsx
// src/ui/components/StageNode.tsx
import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { StageDefinition, StageStatus, StageType } from "../../types.js";

const TYPE_COLORS: Record<StageType, string> = {
  worker: "#3b82f6",
  classifier: "#f59e0b",
  parallel_fan_out: "#06b6d4",
  gate: "#8b5cf6",
  "sub-pipeline": "#22c55e",
};

const TYPE_BADGES: Record<StageType, string> = {
  worker: "WRK",
  classifier: "CLS",
  parallel_fan_out: "FAN",
  gate: "GTE",
  "sub-pipeline": "SUB",
};

const STATUS_BORDERS: Record<StageStatus | "none", string> = {
  none: "1px solid #374151",
  pending: "1px solid #6b7280",
  running: "2px solid #3b82f6",
  completed: "2px solid #22c55e",
  failed: "2px solid #ef4444",
  skipped: "1px dashed #6b7280",
};

export interface StageNodeData {
  stage: StageDefinition;
  status?: StageStatus;
  subtitle?: string;
}

export function StageNode({ data }: NodeProps) {
  const { stage, status, subtitle } = data as unknown as StageNodeData;
  const color = TYPE_COLORS[stage.type];
  const badge = TYPE_BADGES[stage.type];
  const border = STATUS_BORDERS[status ?? "none"];

  return (
    <div style={{
      width: 200,
      height: 90,
      borderRadius: 8,
      border,
      background: "#1f2937",
      display: "flex",
      overflow: "hidden",
      position: "relative",
    }}>
      <div style={{ width: 4, background: color, flexShrink: 0 }} />
      <div style={{ padding: "10px 12px", flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
        <div style={{ fontWeight: 600, fontSize: 13, color: "#f9fafb" }}>{stage.id}</div>
        {subtitle && <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>{subtitle}</div>}
      </div>
      <div style={{
        position: "absolute",
        top: 8,
        right: 8,
        fontSize: 10,
        fontWeight: 700,
        background: color,
        color: "#fff",
        borderRadius: 10,
        padding: "2px 6px",
      }}>
        {badge}
      </div>
      <Handle type="target" position={Position.Top} style={{ background: "#6b7280" }} />
      <Handle type="source" position={Position.Bottom} style={{ background: "#6b7280" }} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/components/StageNode.tsx
git commit -m "feat(pipeline-engine): add StageNode component"
```

---

### Task 14: Create StagePalette component

**Files:**
- Create: `src/ui/components/StagePalette.tsx`

- [ ] **Step 1: Implement draggable palette**

```tsx
// src/ui/components/StagePalette.tsx
import type { StageType } from "../../types.js";

interface PaletteItem {
  type: StageType;
  label: string;
  description: string;
}

const ITEMS: PaletteItem[] = [
  { type: "worker", label: "Worker", description: "Assign agent to do work" },
  { type: "classifier", label: "Classifier", description: "Agent makes a decision" },
  { type: "parallel_fan_out", label: "Parallel Fan-out", description: "Split into parallel branches" },
  { type: "gate", label: "Gate", description: "Conditional checkpoint" },
  { type: "sub-pipeline", label: "Sub-pipeline", description: "Nest another pipeline" },
];

export function StagePalette() {
  function onDragStart(event: React.DragEvent, item: PaletteItem) {
    event.dataTransfer.setData("application/pipeline-stage-type", item.type);
    event.dataTransfer.effectAllowed = "move";
  }

  return (
    <div style={{ width: 200, padding: 12, borderRight: "1px solid #374151", overflowY: "auto" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af", marginBottom: 12, textTransform: "uppercase" }}>
        Stages
      </div>
      {ITEMS.map((item) => (
        <div
          key={item.type}
          draggable
          onDragStart={(e) => onDragStart(e, item)}
          style={{
            padding: "10px 12px",
            marginBottom: 8,
            background: "#1f2937",
            borderRadius: 6,
            cursor: "grab",
            border: "1px solid #374151",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "#f9fafb" }}>{item.label}</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{item.description}</div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/components/StagePalette.tsx
git commit -m "feat(pipeline-engine): add StagePalette component"
```

---

### Task 15: Create StageInspector component

**Files:**
- Create: `src/ui/components/StageInspector.tsx`

- [ ] **Step 1: Implement context-sensitive inspector**

```tsx
// src/ui/components/StageInspector.tsx
import { useState, useEffect } from "react";
import type { StageDefinition, EdgeDefinition, StageType } from "../../types.js";

interface StageInspectorProps {
  stage: StageDefinition | null;
  edge: EdgeDefinition | null;
  agents: Array<{ id: string; name: string }>;
  onStageChange: (stage: StageDefinition) => void;
  onEdgeChange: (edge: EdgeDefinition) => void;
  onEdgeDelete: (edgeId: string) => void;
}

export function StageInspector({ stage, edge, agents, onStageChange, onEdgeChange, onEdgeDelete }: StageInspectorProps) {
  if (!stage && !edge) {
    return (
      <div style={{ width: 320, padding: 16, borderLeft: "1px solid #374151", color: "#9ca3af", fontSize: 13 }}>
        Select a node or edge to inspect
      </div>
    );
  }

  if (edge) {
    return (
      <div style={{ width: 320, padding: 16, borderLeft: "1px solid #374151" }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "#f9fafb", marginBottom: 12 }}>Edge</div>
        <label style={labelStyle}>Source → Target</label>
        <div style={valueStyle}>{edge.from} → {edge.to}</div>
        <label style={labelStyle}>Condition</label>
        <input
          style={inputStyle}
          value={edge.when ?? ""}
          onChange={(e) => onEdgeChange({ ...edge, when: e.target.value || undefined })}
          placeholder="e.g. output.type = 'feature'"
        />
        <label style={labelStyle}>Label</label>
        <input
          style={inputStyle}
          value={edge.label ?? ""}
          onChange={(e) => onEdgeChange({ ...edge, label: e.target.value || undefined })}
        />
        <button onClick={() => onEdgeDelete(edge.id)} style={deleteButtonStyle}>Delete Edge</button>
      </div>
    );
  }

  return (
    <div style={{ width: 320, padding: 16, borderLeft: "1px solid #374151", overflowY: "auto" }}>
      <div style={{ fontSize: 14, fontWeight: 600, color: "#f9fafb", marginBottom: 12 }}>Stage: {stage!.id}</div>
      <label style={labelStyle}>Label</label>
      <input
        style={inputStyle}
        value={stage!.id}
        onChange={(e) => onStageChange({ ...stage!, id: e.target.value })}
      />
      <label style={labelStyle}>Type</label>
      <select
        style={inputStyle}
        value={stage!.type}
        onChange={(e) => onStageChange({ ...stage!, type: e.target.value as StageType } as StageDefinition)}
      >
        <option value="worker">Worker</option>
        <option value="classifier">Classifier</option>
        <option value="parallel_fan_out">Parallel Fan-out</option>
        <option value="gate">Gate</option>
        <option value="sub-pipeline">Sub-pipeline</option>
      </select>
      <label style={labelStyle}>Timeout</label>
      <input
        style={inputStyle}
        value={stage!.timeout ?? ""}
        onChange={(e) => onStageChange({ ...stage!, timeout: e.target.value || undefined })}
        placeholder="e.g. 30m"
      />
      <label style={labelStyle}>
        <input
          type="checkbox"
          checked={stage!.checkpoint ?? false}
          onChange={(e) => onStageChange({ ...stage!, checkpoint: e.target.checked })}
        />
        {" "}Checkpoint
      </label>
      {(stage!.type === "worker" || stage!.type === "classifier") && (
        <>
          <label style={labelStyle}>Agent Role</label>
          <input
            style={inputStyle}
            value={"agent_role" in stage! ? (stage as any).agent_role ?? "" : ""}
            onChange={(e) => onStageChange({ ...stage!, agent_role: e.target.value } as StageDefinition)}
            list="agent-roles"
          />
          <datalist id="agent-roles">
            {agents.map((a) => <option key={a.id} value={a.name} />)}
          </datalist>
          <label style={labelStyle}>Output Schema</label>
          <input
            style={inputStyle}
            value={"output_schema" in stage! ? (stage as any).output_schema ?? "" : ""}
            onChange={(e) => onStageChange({ ...stage!, output_schema: e.target.value || undefined } as StageDefinition)}
            placeholder="schemas/output.json"
          />
        </>
      )}
      {stage!.type === "parallel_fan_out" && (
        <>
          <label style={labelStyle}>Fan-in Strategy</label>
          <select
            style={inputStyle}
            value={"fan_in" in stage! ? (stage as any).fan_in ?? "all_complete" : "all_complete"}
            onChange={(e) => onStageChange({ ...stage!, fan_in: e.target.value } as StageDefinition)}
          >
            <option value="all_complete">All Complete</option>
            <option value="first_complete">First Complete</option>
          </select>
        </>
      )}
      {stage!.type === "sub-pipeline" && (
        <>
          <label style={labelStyle}>Pipeline Reference</label>
          <input
            style={inputStyle}
            value={"pipeline" in stage! ? (stage as any).pipeline ?? "" : ""}
            onChange={(e) => onStageChange({ ...stage!, pipeline: e.target.value } as StageDefinition)}
          />
        </>
      )}
      <div style={{ marginTop: 16, borderTop: "1px solid #374151", paddingTop: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#9ca3af", marginBottom: 8 }}>On Failure</div>
        <label style={labelStyle}>Max Retries</label>
        <input
          type="number"
          style={inputStyle}
          value={stage!.retry?.max_retries ?? 0}
          onChange={(e) => {
            const val = parseInt(e.target.value) || 0;
            onStageChange({ ...stage!, retry: val > 0 ? { ...stage!.retry, max_retries: val } : undefined } as StageDefinition);
          }}
        />
        {stage!.retry && (
          <>
            <label style={labelStyle}>Retry Body Template</label>
            <textarea
              style={{ ...inputStyle, height: 60, resize: "vertical" }}
              value={stage!.retry.body ?? ""}
              onChange={(e) => onStageChange({ ...stage!, retry: { ...stage!.retry!, body: e.target.value || undefined } } as StageDefinition)}
              placeholder="Fix: {{output.issues}}"
            />
          </>
        )}
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: "block", fontSize: 11, color: "#9ca3af", marginTop: 10, marginBottom: 4 };
const inputStyle: React.CSSProperties = { width: "100%", padding: "6px 8px", background: "#111827", border: "1px solid #374151", borderRadius: 4, color: "#f9fafb", fontSize: 13 };
const valueStyle: React.CSSProperties = { fontSize: 13, color: "#f9fafb" };
const deleteButtonStyle: React.CSSProperties = { marginTop: 16, padding: "6px 12px", background: "#7f1d1d", color: "#fca5a5", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 };
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/components/StageInspector.tsx
git commit -m "feat(pipeline-engine): add StageInspector component"
```

---

### Task 16: Create PipelineCanvas (builder view)

**Files:**
- Create: `src/ui/components/PipelineCanvas.tsx`

- [ ] **Step 1: Implement ReactFlow canvas with three-panel layout**

```tsx
// src/ui/components/PipelineCanvas.tsx
import { useCallback, useState, useRef } from "react";
import { ReactFlow, addEdge, useNodesState, useEdgesState, Background, Controls, type Connection, type Edge, type Node } from "@xyflow/react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import { StageNode, type StageNodeData } from "./StageNode.js";
import { StagePalette } from "./StagePalette.js";
import { StageInspector } from "./StageInspector.js";
import { computeAutoLayout } from "../hooks/useAutoLayout.js";
import { DATA_KEYS, ACTION_KEYS } from "../constants.js";
import type { PipelineDefinition, StageDefinition, EdgeDefinition, StageType } from "../../types.js";

const nodeTypes = { stage: StageNode };

interface PipelineCanvasProps {
  pipeline: PipelineDefinition | null;
  onBack: () => void;
  companyId: string;
}

let idCounter = 0;
function nextId(prefix: string) {
  return `${prefix}-${++idCounter}`;
}

function stageToNode(stage: StageDefinition, position: { x: number; y: number }): Node {
  return {
    id: stage.id,
    type: "stage",
    position,
    data: { stage, subtitle: "agent_role" in stage ? stage.agent_role : undefined } satisfies StageNodeData,
  };
}

function edgeDefToFlowEdge(edge: EdgeDefinition): Edge {
  return {
    id: edge.id,
    source: edge.from,
    target: edge.to,
    label: edge.label,
    animated: edge.type === "error",
    style: edge.type === "error" ? { stroke: "#ef4444" } : undefined,
  };
}

export function PipelineCanvas({ pipeline, onBack, companyId }: PipelineCanvasProps) {
  const savePipeline = usePluginAction(ACTION_KEYS.SAVE_PIPELINE);
  const { data: agents } = usePluginData<Array<{ id: string; name: string }>>(DATA_KEYS.LIST_AGENTS, { companyId });

  const [pipelineName, setPipelineName] = useState(pipeline?.name ?? "");
  const [pipelineDesc, setPipelineDesc] = useState(pipeline?.description ?? "");
  const [triggerLabel, setTriggerLabel] = useState(pipeline?.trigger.label ?? "");

  const initialNodes = (pipeline?.stages ?? []).map((s) =>
    stageToNode(s, pipeline?.positions[s.id] ?? { x: 0, y: 0 }),
  );
  const initialEdges = (pipeline?.edges ?? []).map(edgeDefToFlowEdge);

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const [selectedStage, setSelectedStage] = useState<StageDefinition | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<EdgeDefinition | null>(null);
  const reactFlowRef = useRef<HTMLDivElement>(null);

  const onConnect = useCallback((params: Connection) => {
    const id = nextId("e");
    setEdges((eds) => addEdge({
      ...params,
      id,
      data: { when: undefined, edgeType: undefined },
    }, eds));
  }, [setEdges]);

  const onDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/pipeline-stage-type") as StageType;
    if (!type) return;

    const bounds = reactFlowRef.current?.getBoundingClientRect();
    if (!bounds) return;

    const position = {
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    };

    const id = nextId(type.replace(/_/g, "-"));
    const stage: StageDefinition = buildDefaultStage(id, type);
    setNodes((nds) => [...nds, stageToNode(stage, position)]);
  }, [setNodes]);

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedEdge(null);
    setSelectedStage((node.data as StageNodeData).stage);
  }, []);

  const onEdgeClick = useCallback((_: React.MouseEvent, edge: Edge) => {
    setSelectedStage(null);
    const edgeDef: EdgeDefinition = {
      id: edge.id,
      from: edge.source,
      to: edge.target,
      type: (edge.data as any)?.edgeType,
      when: (edge.data as any)?.when,
      label: edge.label as string | undefined,
    };
    setSelectedEdge(edgeDef);
  }, []);

  function handleAutoLayout() {
    const stages = nodes.map((n) => (n.data as StageNodeData).stage);
    const edgeDefs = edges.map((e) => ({ id: e.id, from: e.source, to: e.target } as EdgeDefinition));
    const { positions } = computeAutoLayout(stages, edgeDefs);
    setNodes((nds) => nds.map((n) => ({ ...n, position: positions[n.id] ?? n.position })));
  }

  async function handleSave() {
    const stages = nodes.map((n) => (n.data as StageNodeData).stage);
    const edgeDefs: EdgeDefinition[] = edges.map((e) => ({
      id: e.id,
      from: e.source,
      to: e.target,
      type: (e.data as any)?.edgeType as EdgeDefinition["type"],
      label: e.label as string | undefined,
      when: (e.data as any)?.when as string | undefined,
    }));
    const positions: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) {
      positions[n.id] = n.position;
    }

    const def: PipelineDefinition = {
      name: pipelineName,
      description: pipelineDesc,
      trigger: { label: triggerLabel },
      stages,
      edges: edgeDefs,
      positions,
    };

    await savePipeline({ companyId, pipeline: def });
  }

  function handleStageChange(updated: StageDefinition) {
    setSelectedStage(updated);
    setNodes((nds) => nds.map((n) =>
      n.id === updated.id ? { ...n, data: { stage: updated, subtitle: "agent_role" in updated ? updated.agent_role : undefined } } : n,
    ));
  }

  function handleEdgeChange(updated: EdgeDefinition) {
    setSelectedEdge(updated);
    setEdges((eds) => eds.map((e) =>
      e.id === updated.id ? {
        ...e,
        label: updated.label,
        animated: updated.type === "error",
        data: { ...((e.data as object) ?? {}), when: updated.when, edgeType: updated.type },
      } : e,
    ));
  }

  function handleEdgeDelete(edgeId: string) {
    setEdges((eds) => eds.filter((e) => e.id !== edgeId));
    setSelectedEdge(null);
  }

  return (
    <div style={{ display: "flex", height: "100%", background: "#111827" }}>
      <StagePalette />
      <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "8px 12px", borderBottom: "1px solid #374151", display: "flex", gap: 8, alignItems: "center" }}>
          <button onClick={onBack} style={toolbarBtnStyle}>← Back</button>
          <input style={toolbarInputStyle} value={pipelineName} onChange={(e) => setPipelineName(e.target.value)} placeholder="Pipeline name" />
          <input style={{ ...toolbarInputStyle, flex: 1 }} value={pipelineDesc} onChange={(e) => setPipelineDesc(e.target.value)} placeholder="Description" />
          <input style={toolbarInputStyle} value={triggerLabel} onChange={(e) => setTriggerLabel(e.target.value)} placeholder="Trigger label" />
          <button onClick={handleAutoLayout} style={toolbarBtnStyle}>Auto-layout</button>
          <button onClick={handleSave} style={{ ...toolbarBtnStyle, background: "#1d4ed8" }}>Save</button>
        </div>
        <div ref={reactFlowRef} style={{ flex: 1 }} onDrop={onDrop} onDragOver={onDragOver}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onEdgeClick={onEdgeClick}
            fitView
          >
            <Background color="#374151" gap={20} />
            <Controls />
          </ReactFlow>
        </div>
      </div>
      <StageInspector
        stage={selectedStage}
        edge={selectedEdge}
        agents={agents ?? []}
        onStageChange={handleStageChange}
        onEdgeChange={handleEdgeChange}
        onEdgeDelete={handleEdgeDelete}
      />
    </div>
  );
}

function buildDefaultStage(id: string, type: StageType): StageDefinition {
  switch (type) {
    case "worker": return { id, type, agent_role: "" };
    case "classifier": return { id, type, agent_role: "" };
    case "parallel_fan_out": return { id, type, fan_in: "all_complete" };
    case "gate": return { id, type };
    case "sub-pipeline": return { id, type, pipeline: "" };
  }
}

const toolbarBtnStyle: React.CSSProperties = { padding: "4px 10px", background: "#374151", color: "#f9fafb", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 12 };
const toolbarInputStyle: React.CSSProperties = { padding: "4px 8px", background: "#1f2937", border: "1px solid #374151", borderRadius: 4, color: "#f9fafb", fontSize: 13, width: 140 };
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/components/PipelineCanvas.tsx
git commit -m "feat(pipeline-engine): add PipelineCanvas builder component"
```

---

### Task 17: Create PipelineList component (page slot)

**Files:**
- Create: `src/ui/components/PipelineList.tsx`

- [ ] **Step 1: Implement list view with navigation to builder**

```tsx
// src/ui/components/PipelineList.tsx
import { useState } from "react";
import { usePluginData, usePluginAction, useHostContext } from "@paperclipai/plugin-sdk/ui";
import { DATA_KEYS, ACTION_KEYS } from "../constants.js";
import { PipelineCanvas } from "./PipelineCanvas.js";
import type { PipelineDefinition } from "../../types.js";

interface PipelineSummary {
  name: string;
  description: string;
  trigger: { label: string };
  stageCount: number;
  edgeCount: number;
}

export function PipelinesPage() {
  const { companyId } = useHostContext();
  const { data: pipelines, loading, refresh } = usePluginData<PipelineSummary[]>(DATA_KEYS.LIST_PIPELINES, { companyId });
  const deletePipeline = usePluginAction(ACTION_KEYS.DELETE_PIPELINE);
  const triggerRun = usePluginAction(ACTION_KEYS.TRIGGER_RUN);

  const [editingPipelineName, setEditingPipelineName] = useState<string | "new" | null>(null);

  // Fetch full pipeline definition when editing (hook called unconditionally)
  const { data: editingPipelineDef } = usePluginData<PipelineDefinition>(
    DATA_KEYS.GET_PIPELINE,
    editingPipelineName && editingPipelineName !== "new" ? { companyId, pipelineName: editingPipelineName } : undefined,
  );

  if (editingPipelineName !== null) {
    const pipelineToEdit = editingPipelineName === "new" ? null : (editingPipelineDef ?? null);
    if (editingPipelineName !== "new" && !editingPipelineDef) {
      return <div style={{ padding: 24, color: "#9ca3af" }}>Loading pipeline…</div>;
    }
    return (
      <PipelineCanvas
        pipeline={pipelineToEdit}
        onBack={() => { setEditingPipelineName(null); refresh(); }}
        companyId={companyId}
      />
    );
  }

  if (loading) return <div style={{ padding: 24, color: "#9ca3af" }}>Loading pipelines…</div>;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: "#f9fafb" }}>Pipelines</h1>
        <button onClick={() => setEditingPipelineName("new")} style={primaryBtnStyle}>Create Pipeline</button>
      </div>
      {(!pipelines || pipelines.length === 0) ? (
        <div style={{ color: "#9ca3af", textAlign: "center", padding: 48 }}>
          No pipelines yet. Create one to get started.
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid #374151" }}>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>Description</th>
              <th style={thStyle}>Trigger</th>
              <th style={thStyle}>Stages</th>
              <th style={thStyle}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {pipelines.map((p) => (
              <tr key={p.name} style={{ borderBottom: "1px solid #1f2937" }}>
                <td style={tdStyle}>{p.name}</td>
                <td style={tdStyle}>{p.description}</td>
                <td style={tdStyle}><code style={{ fontSize: 12 }}>{p.trigger.label}</code></td>
                <td style={tdStyle}>{p.stageCount}</td>
                <td style={tdStyle}>
                  <button onClick={() => setEditingPipelineName(p.name)} style={actionBtnStyle}>Edit</button>
                  <button onClick={() => handleDelete(p.name)} style={{ ...actionBtnStyle, color: "#fca5a5" }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );

  async function handleDelete(name: string) {
    await deletePipeline({ companyId, pipelineName: name });
    refresh();
  }
}

const primaryBtnStyle: React.CSSProperties = { padding: "8px 16px", background: "#1d4ed8", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 };
const actionBtnStyle: React.CSSProperties = { padding: "4px 8px", background: "transparent", color: "#93c5fd", border: "none", cursor: "pointer", fontSize: 12, marginRight: 8 };
const thStyle: React.CSSProperties = { textAlign: "left", padding: "8px 12px", fontSize: 12, color: "#9ca3af", fontWeight: 600 };
const tdStyle: React.CSSProperties = { padding: "10px 12px", fontSize: 13, color: "#f9fafb" };
```

Note: `usePluginData` is called unconditionally at the top of the component with `editingPipelineName` as the params trigger. When params is `undefined`, the hook should no-op (check SDK behavior — if it doesn't support undefined params, wrap with a conditional render or split into a sub-component).

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/components/PipelineList.tsx
git commit -m "feat(pipeline-engine): add PipelineList page component"
```

---

### Task 18: Create RunReplayCanvas and RunHistory components

**Files:**
- Create: `src/ui/components/RunReplayCanvas.tsx`
- Create: `src/ui/components/RunHistory.tsx`

- [ ] **Step 1: Implement RunReplayCanvas (read-only execution view)**

```tsx
// src/ui/components/RunReplayCanvas.tsx
import { useMemo } from "react";
import { ReactFlow, Background, Controls, type Node, type Edge } from "@xyflow/react";
import { usePluginStream } from "@paperclipai/plugin-sdk/ui";
import { StageNode, type StageNodeData } from "./StageNode.js";
import { STREAM_CHANNELS } from "../constants.js";
import type { PipelineDefinition, PipelineStage, StageStatus } from "../../types.js";

const nodeTypes = { stage: StageNode };

interface RunReplayCanvasProps {
  pipeline: PipelineDefinition;
  stages: PipelineStage[];
  runId: string;
  companyId: string;
}

export function RunReplayCanvas({ pipeline, stages, runId, companyId }: RunReplayCanvasProps) {
  const { lastEvent } = usePluginStream<{ runId: string; stageId: string; status: StageStatus }>(
    STREAM_CHANNELS.RUN_PROGRESS,
    { companyId },
  );

  const stageStatusMap = useMemo(() => {
    const map = new Map(stages.map((s) => [s.stageId, s.status]));
    if (lastEvent && lastEvent.runId === runId) {
      map.set(lastEvent.stageId, lastEvent.status);
    }
    return map;
  }, [stages, lastEvent, runId]);

  const nodes: Node[] = pipeline.stages.map((s) => ({
    id: s.id,
    type: "stage",
    position: pipeline.positions[s.id] ?? { x: 0, y: 0 },
    data: { stage: s, status: stageStatusMap.get(s.id), subtitle: "agent_role" in s ? s.agent_role : undefined } satisfies StageNodeData,
    draggable: false,
  }));

  const edges: Edge[] = pipeline.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    label: e.label,
    animated: stageStatusMap.get(e.from) === "completed" && stageStatusMap.get(e.to) === "running",
    style: e.type === "error" ? { stroke: "#ef4444" } : undefined,
  }));

  return (
    <div style={{ height: 400 }}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView nodesDraggable={false}>
        <Background color="#374151" gap={20} />
        <Controls />
      </ReactFlow>
    </div>
  );
}
```

- [ ] **Step 2: Implement RunHistory (issue detail tab)**

```tsx
// src/ui/components/RunHistory.tsx
import { useState } from "react";
import { usePluginData, usePluginAction, useHostContext } from "@paperclipai/plugin-sdk/ui";
import { DATA_KEYS, ACTION_KEYS } from "../constants.js";
import { RunReplayCanvas } from "./RunReplayCanvas.js";
import type { PipelineRun, PipelineStage, PipelineDefinition } from "../../types.js";

const STATUS_COLORS: Record<string, string> = {
  running: "#3b82f6",
  completed: "#22c55e",
  failed: "#ef4444",
  cancelled: "#9ca3af",
  escalated: "#f59e0b",
  paused: "#8b5cf6",
};

export function PipelineRunsTab() {
  const { companyId, entityId } = useHostContext();
  const { data: runs, loading } = usePluginData<PipelineRun[]>(DATA_KEYS.LIST_RUNS, { companyId, issueId: entityId });
  const cancelRun = usePluginAction(ACTION_KEYS.CANCEL_RUN);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  if (loading) return <div style={{ padding: 16, color: "#9ca3af" }}>Loading runs…</div>;
  if (!runs || runs.length === 0) return <div style={{ padding: 16, color: "#9ca3af" }}>No pipeline runs for this issue.</div>;

  return (
    <div style={{ padding: 16 }}>
      {runs.map((run) => (
        <div key={run.id} style={{ marginBottom: 12, border: "1px solid #374151", borderRadius: 6 }}>
          <div
            onClick={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
            style={{ padding: "10px 14px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center" }}
          >
            <div>
              <span style={{ fontWeight: 600, color: "#f9fafb", fontSize: 13 }}>{run.pipelineName}</span>
              <span style={{ marginLeft: 8, fontSize: 11, padding: "2px 6px", borderRadius: 10, background: STATUS_COLORS[run.status] ?? "#374151", color: "#fff" }}>
                {run.status}
              </span>
            </div>
            <div style={{ fontSize: 11, color: "#9ca3af" }}>
              {new Date(run.createdAt).toLocaleString()}
              {run.status === "running" && (
                <button onClick={(e) => { e.stopPropagation(); cancelRun({ runId: run.id }); }} style={{ marginLeft: 8, color: "#fca5a5", background: "none", border: "none", cursor: "pointer", fontSize: 11 }}>
                  Cancel
                </button>
              )}
            </div>
          </div>
          {expandedRunId === run.id && <RunDetail runId={run.id} companyId={companyId} />}
        </div>
      ))}
    </div>
  );
}

function RunDetail({ runId, companyId }: { runId: string; companyId: string }) {
  const { data, loading } = usePluginData<{ run: PipelineRun; stages: PipelineStage[]; pipelineDef: PipelineDefinition }>(
    DATA_KEYS.GET_RUN, { runId },
  );

  if (loading || !data) return <div style={{ padding: 12, color: "#9ca3af" }}>Loading…</div>;
  if (!data.pipelineDef) return <div style={{ padding: 12, color: "#fca5a5" }}>Corrupted pipeline definition</div>;

  return (
    <div style={{ padding: 12, borderTop: "1px solid #374151" }}>
      <RunReplayCanvas pipeline={data.pipelineDef} stages={data.stages} runId={runId} companyId={companyId} />
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/components/RunReplayCanvas.tsx packages/plugins/pipeline-engine/src/ui/components/RunHistory.tsx
git commit -m "feat(pipeline-engine): add RunReplayCanvas and RunHistory components"
```

---

### Task 19: Create DashboardWidget and Sidebar components

**Files:**
- Create: `src/ui/components/DashboardWidget.tsx`
- Create: `src/ui/components/PipelinesSidebar.tsx`

- [ ] **Step 1: Implement DashboardWidget**

```tsx
// src/ui/components/DashboardWidget.tsx
import { usePluginData, useHostContext } from "@paperclipai/plugin-sdk/ui";
import { DATA_KEYS } from "../constants.js";
import type { PipelineRun } from "../../types.js";

export function PipelineHealthWidget() {
  const { companyId } = useHostContext();
  const { data: runningRuns } = usePluginData<PipelineRun[]>(DATA_KEYS.LIST_RUNS, { companyId, status: "running", limit: 100 });
  const { data: completedRuns } = usePluginData<PipelineRun[]>(DATA_KEYS.LIST_RUNS, { companyId, status: "completed", limit: 100 });

  const activeCount = runningRuns?.length ?? 0;
  const completedCount = completedRuns?.filter((r) => {
    const createdAt = new Date(r.createdAt);
    return Date.now() - createdAt.getTime() < 24 * 60 * 60 * 1000;
  }).length ?? 0;

  // Stuck: running for >1h with no recent stage progress (simplified: created >1h ago)
  const stuckCount = runningRuns?.filter((r) => {
    const created = new Date(r.createdAt);
    return Date.now() - created.getTime() > 60 * 60 * 1000;
  }).length ?? 0;

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <MetricCard label="Active" value={activeCount} color="#3b82f6" />
        <MetricCard label="Stuck" value={stuckCount} color="#ef4444" />
        <MetricCard label="Completed (24h)" value={completedCount} color="#22c55e" />
      </div>
      {completedRuns && completedRuns.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 6 }}>Recent completions</div>
          {completedRuns.slice(0, 5).map((r) => (
            <div key={r.id} style={{ fontSize: 12, color: "#f9fafb", padding: "4px 0" }}>
              {r.pipelineName} — {r.status}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ flex: 1, padding: 12, background: "#1f2937", borderRadius: 6, textAlign: "center" }}>
      <div style={{ fontSize: 24, fontWeight: 700, color }}>{value}</div>
      <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>{label}</div>
    </div>
  );
}
```

- [ ] **Step 2: Implement PipelinesSidebar**

```tsx
// src/ui/components/PipelinesSidebar.tsx
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";

export function PipelinesSidebar() {
  const nav = useHostNavigation();

  return (
    <a {...nav.linkProps("/pipelines")} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", color: "#f9fafb", textDecoration: "none", fontSize: 13 }}>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <circle cx="8" cy="3" r="2" />
        <circle cx="4" cy="13" r="2" />
        <circle cx="12" cy="13" r="2" />
        <path d="M8 5v3M6.5 9.5L4.5 11M9.5 9.5L11.5 11" />
      </svg>
      Pipelines
    </a>
  );
}
```

- [ ] **Step 3: Update index.tsx to export all components**

```tsx
// src/ui/index.tsx
export { PipelinesPage } from "./components/PipelineList.js";
export { PipelineRunsTab } from "./components/RunHistory.js";
export { PipelinesSidebar } from "./components/PipelinesSidebar.js";
export { PipelineHealthWidget } from "./components/DashboardWidget.js";
```

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/pipeline-engine/src/ui/
git commit -m "feat(pipeline-engine): add DashboardWidget and Sidebar components"
```

---

### Task 20: Build verification

**Files:**
- All UI and worker files

- [ ] **Step 1: Run typecheck**

Run: `cd packages/plugins/pipeline-engine && pnpm typecheck`
Expected: PASS

- [ ] **Step 2: Run full test suite**

Run: `cd packages/plugins/pipeline-engine && pnpm test`
Expected: ALL PASS

- [ ] **Step 3: Build worker**

Run: `cd packages/plugins/pipeline-engine && pnpm build`
Expected: Both worker and UI bundles built successfully

- [ ] **Step 4: Verify dist output**

Run: `ls packages/plugins/pipeline-engine/dist/ui/index.js`
Expected: File exists

- [ ] **Step 5: Final commit with any fixes**

```bash
git add .
git commit -m "feat(pipeline-engine): complete UI build pipeline"
```

---

## Summary

| Chunk | Tasks | Description |
|-------|-------|-------------|
| 1 | Tasks 1-7 | Engine refactoring: types → edge utils → dag-parser → expression → router → state machine → worker |
| 2 | Tasks 8-10 | Backend bridge: manifest → data/action/stream handlers → package deps + build |
| 3 | Tasks 11-20 | UI components: constants → auto-layout → StageNode → palette → inspector → canvas → list → replay → widget → sidebar → build verification |

Total estimated time: ~4-6 hours for a single agent, ~2 hours with parallel subagents (chunks 2-3 can partially overlap after chunk 1 completes).
