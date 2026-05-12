# Pipeline Engine Plugin — Implementation Plan

> **For agentic workers:** REQUIRED: Use forge:subagent-driven-development (if subagents available) or forge:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

---

## Progress

> **IMPLEMENTATION INSTRUCTION:** Update this progress bar after completing each task. Check off the task, update the fraction, and update the bar visualization. This gives humans and other agents immediate visibility into how far along the work is.

| Status | Progress |
|--------|----------|
| Complete | `[ 16 / 16 tasks ]` |

```
████████████████████████████████████████  100%
```

| # | Task | Status |
|---|------|--------|
| 1 | Initialize Plugin Package | ✅ |
| 2 | Define TypeScript Types | ✅ |
| 3 | Create Plugin Manifest | ✅ |
| 4 | Create Database Migration | ✅ |
| 5 | Expression Engine (JSONata Wrapper) | ✅ |
| 6 | Template Engine (Handlebars) | ✅ |
| 7 | DAG Parser | ✅ |
| 8 | JSON Schema Files | ✅ |
| 9 | Output Parser | ✅ |
| 10 | State Machine (DB Operations) | ✅ |
| 11 | Trigger Matcher | ✅ |
| 12 | Dispatcher | ✅ |
| 13 | Router | ✅ |
| 14 | Worker Entry Point | ✅ |
| 15 | Example Pipeline YAML Definitions | ✅ |
| 16 | Integration Test & Build Verification | ✅ |

### How to update

After completing a task:
1. Change the task's status from `⬜` to `✅`
2. Update the fraction: `[ N / 16 tasks ]`
3. Update the bar: each task = 2.5 chars of `█`. Example for 4/16 done:
   ```
   ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  25%
   ```
4. If a task is **in progress**, mark it `🔨` and note the step you're on (e.g., `🔨 Step 3/5`)

---

**Goal:** Build a deterministic routing plugin that replaces agent-directed orchestration with YAML-defined state-machine pipelines, where agents become pure workers/classifiers and the engine makes all routing decisions.

**Architecture:** A Paperclip adapter plugin (`packages/plugins/pipeline-engine/`) that subscribes to issue events, matches trigger labels, materializes DAGs from YAML definitions, dispatches sub-issues to agents, parses structured output from comments, and routes based on DAG rules. State is persisted in a plugin-owned PostgreSQL schema.

**Tech Stack:** TypeScript, @paperclipai/plugin-sdk, PostgreSQL (via ctx.db), JSONata (expression evaluation), Handlebars (template interpolation), Ajv (JSON Schema validation), js-yaml (YAML parsing), Vitest (testing)

**Verification Criteria:**
- [ ] Plugin loads and passes health check
- [ ] YAML pipeline definitions are parsed and validated (no cycles, valid references)
- [ ] Trigger matcher correctly identifies pipeline labels on issues
- [ ] State machine persists pipeline runs and stage transitions
- [ ] Dispatcher creates sub-issues with correct assignments and context
- [ ] Output parser detects sentinel-marked comments and validates against schemas
- [ ] Router evaluates JSONata conditions and dispatches next stages
- [ ] Retry/goto logic resets stages and creates new sub-issues with failure context
- [ ] Fan-out/fan-in correctly handles parallel stages
- [ ] Checkpoint stages pause and resume materialization
- [ ] Gate stages evaluate conditions without agent involvement
- [ ] Sub-pipeline creation from decomposer output works end-to-end
- [ ] Escalation on max_retries triggers correct state transition and comment

**Spec:** `docs/specs/2026-05-10-pipeline-engine-design.md`

---

## Scope Note

This plan covers **Step 2** from the spec: the deterministic routing engine plugin. Step 1 (disabling built-in Paperclip skills per agent) is a separate fork change with its own plan. Step 3 (learning cycle) is a future phase not covered here.

---

## File Structure

```
packages/plugins/pipeline-engine/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── esbuild.config.mjs
├── migrations/
│   └── 001_pipeline_tables.sql
├── pipelines/                          # Example YAML pipeline definitions
│   ├── feature.yaml
│   ├── bug.yaml
│   ├── fast-track.yaml
│   ├── test-writing.yaml
│   └── implementation.yaml
├── schemas/                            # JSON Schema files for output validation
│   ├── spec-review-output.json
│   ├── decomposition-output.json
│   ├── implementation-output.json
│   ├── validation-output.json
│   ├── review-output.json
│   ├── merge-output.json
│   └── classification-output.json
└── src/
    ├── index.ts                        # Re-exports manifest
    ├── manifest.ts                     # Plugin manifest declaration
    ├── worker.ts                       # Plugin entry: setup(), event handlers, wiring
    ├── types.ts                        # All shared TypeScript types
    ├── dag-parser.ts                   # YAML parsing, DAG validation, cycle detection
    ├── trigger-matcher.ts              # Label matching logic, pipeline materialization trigger
    ├── state-machine.ts                # DB operations for pipeline_runs/pipeline_stages
    ├── dispatcher.ts                   # Sub-issue creation, agent assignment, wakeup
    ├── output-parser.ts                # Sentinel comment detection, JSON extraction, schema validation
    ├── router.ts                       # Condition evaluation, next-stage determination, retry/goto
    ├── expression-engine.ts            # JSONata wrapper, variable namespace construction
    ├── template-engine.ts              # Handlebars-style {{ }} interpolation for retry bodies
    └── tests/
        ├── dag-parser.test.ts
        ├── trigger-matcher.test.ts
        ├── state-machine.test.ts
        ├── dispatcher.test.ts
        ├── output-parser.test.ts
        ├── router.test.ts
        ├── expression-engine.test.ts
        └── template-engine.test.ts
```

---

## Chunk 1: Project Scaffolding & Types

### Task 1: Initialize Plugin Package

**Files:**
- Create: `packages/plugins/pipeline-engine/package.json`
- Create: `packages/plugins/pipeline-engine/tsconfig.json`
- Create: `packages/plugins/pipeline-engine/vitest.config.ts`
- Create: `packages/plugins/pipeline-engine/esbuild.config.mjs`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@paperclipai/plugin-pipeline-engine",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "description": "Deterministic YAML-defined state-machine pipeline engine for Paperclip",
  "scripts": {
    "prebuild": "pnpm --filter @paperclipai/plugin-sdk ensure-build-deps",
    "build": "node ./esbuild.config.mjs",
    "dev": "node ./esbuild.config.mjs --watch",
    "test": "vitest run --config ./vitest.config.ts",
    "typecheck": "pnpm --filter @paperclipai/plugin-sdk ensure-build-deps && tsc --noEmit"
  },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js"
  },
  "keywords": ["paperclip", "plugin", "pipeline", "orchestration"],
  "author": "Paperclip",
  "license": "MIT",
  "dependencies": {
    "@paperclipai/plugin-sdk": "workspace:*",
    "ajv": "^8.17.0",
    "handlebars": "^4.7.8",
    "js-yaml": "^4.1.0",
    "jsonata": "^2.0.5"
  },
  "devDependencies": {
    "@paperclipai/shared": "workspace:*",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^24.6.0",
    "esbuild": "^0.27.3",
    "typescript": "^5.7.3",
    "vitest": "^3.0.5"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Create esbuild.config.mjs**

```javascript
import { cpSync } from "node:fs";
import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({});
const watch = process.argv.includes("--watch");

const workerCtx = await esbuild.context(presets.esbuild.worker);
const manifestCtx = await esbuild.context(presets.esbuild.manifest);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch()]);
  console.log("esbuild watch mode enabled for worker and manifest");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose()]);
  // Copy schema files to dist so output-parser can resolve them at runtime
  cpSync("schemas", "dist/schemas", { recursive: true });
}
```

- [ ] **Step 5: Run pnpm install to link workspace deps**

Run: `pnpm install`

- [ ] **Step 6: Verify typecheck passes (empty project)**

Run: `cd packages/plugins/pipeline-engine && pnpm typecheck`
Expected: PASS (no source files yet, so no errors)

- [ ] **Step 7: Commit**

```bash
git add packages/plugins/pipeline-engine/package.json packages/plugins/pipeline-engine/tsconfig.json packages/plugins/pipeline-engine/vitest.config.ts packages/plugins/pipeline-engine/esbuild.config.mjs
git commit -m "feat(pipeline-engine): scaffold plugin package"
```

---

### Task 2: Define TypeScript Types

**Files:**
- Create: `packages/plugins/pipeline-engine/src/types.ts`

- [ ] **Step 1: Write the types file**

```typescript
export type PipelineRunStatus = "running" | "paused" | "completed" | "failed" | "escalated";

export type StageStatus = "pending" | "running" | "completed" | "failed" | "skipped";

export type StageType = "worker" | "classifier" | "parallel_fan_out" | "gate" | "sub-pipeline";

export type FanInStrategy = "all_complete" | "first_complete";

export interface OnFailure {
  retry_with?: {
    goto: string;
    body: string;
    max_retries: number;
  };
}

export interface StageDefinition {
  id: string;
  type: StageType;
  agent_role?: string;
  depends_on?: string[];
  condition?: string;
  skip_if?: string;
  output_schema?: string;
  checkpoint?: boolean;
  fan_in?: FanInStrategy;
  timeout?: string;
  on_failure?: OnFailure;
  per_task?: boolean;
  ordering?: string;
  pipeline?: string;
  requires_approval?: boolean;
  stages?: StageDefinition[];
}

export interface PipelineTrigger {
  label: string;
}

export interface PipelineDefinition {
  name: string;
  description: string;
  trigger: PipelineTrigger;
  stages: StageDefinition[];
}

export interface PipelineRun {
  id: string;
  companyId: string;
  parentIssueId: string;
  pipelineName: string;
  pipelineVersion: number;
  pipelineYaml: string;
  status: PipelineRunStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface PipelineStage {
  id: string;
  pipelineRunId: string;
  stageId: string;
  subIssueId: string | null;
  status: StageStatus;
  retryCount: number;
  output: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface SubPipelineRun {
  id: string;
  parentPipelineRunId: string;
  parentStageId: string;
  childPipelineRunId: string;
  taskIndex: number;
  orderingPosition: number;
}

export interface RoleMapping {
  [role: string]: string;
}

export interface PipelineEngineConfig {
  role_mapping: RoleMapping;
  trigger_labels: Record<string, string>;
  pipelines_dir?: string;
}

export interface StageOutput {
  status?: string;
  decision?: string;
  [key: string]: unknown;
}

export interface ExpressionContext {
  stages: Record<string, { output: StageOutput | null; status: StageStatus; retry_count: number }>;
  pipeline: { name: string; version: number; parent_issue_id: string };
  env: { company_id: string };
}

export interface DispatchRequest {
  pipelineRunId: string;
  stage: StageDefinition;
  companyId: string;
  parentIssueId: string;
  context?: string;
}

export interface ParsedOutput {
  valid: boolean;
  data: Record<string, unknown> | null;
  error?: string;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd packages/plugins/pipeline-engine && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/pipeline-engine/src/types.ts
git commit -m "feat(pipeline-engine): add TypeScript type definitions"
```

---

### Task 3: Create Plugin Manifest

**Files:**
- Create: `packages/plugins/pipeline-engine/src/manifest.ts`
- Create: `packages/plugins/pipeline-engine/src/index.ts`

- [ ] **Step 1: Write manifest.ts**

```typescript
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclipai.pipeline-engine",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Pipeline Engine",
  description: "Deterministic YAML-defined state-machine pipeline engine for orchestrating agent work.",
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
  ],
  entrypoints: {
    worker: "./dist/worker.js",
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
      pipelines_dir: {
        type: "string",
        title: "Pipelines Directory",
        description: "Path to YAML pipeline definitions (relative to workspace root)",
        default: "pipelines",
      },
    },
    required: ["role_mapping", "trigger_labels"],
  },
  apiRoutes: [
    { routeKey: "run-status", method: "GET", path: "/runs/:runId", auth: "board-or-agent", capability: "api.routes.register" },
    { routeKey: "pipelines", method: "GET", path: "/pipelines", auth: "board-or-agent", capability: "api.routes.register" },
  ],
  database: {
    namespaceSlug: "pipeline_engine",
    migrationsDir: "migrations",
    coreReadTables: ["issues", "labels"],
  },
};

export default manifest;
```

- [ ] **Step 2: Write index.ts**

```typescript
export { default } from "./manifest.js";
```

- [ ] **Step 3: Verify typecheck**

Run: `cd packages/plugins/pipeline-engine && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/plugins/pipeline-engine/src/manifest.ts packages/plugins/pipeline-engine/src/index.ts
git commit -m "feat(pipeline-engine): add plugin manifest"
```

---

### Task 4: Create Database Migration

**Files:**
- Create: `packages/plugins/pipeline-engine/migrations/001_pipeline_tables.sql`

- [ ] **Step 1: Write the migration**

The namespace prefix will be something like `plugin_pipeline_engine_<hash>`. Use a placeholder that matches the pattern from the SDK's namespace resolution. For now, use `__NAMESPACE__` as placeholder — the plugin SDK resolves the actual namespace at migration time.

Actually, looking at the orchestration smoke example, migrations use the full prefixed table name directly: `plugin_orchestration_smoke_1e8c264c64.smoke_runs`. We need to check how the namespace is computed. For the plan, we'll use the SDK's `ctx.db.namespace` pattern in queries (as the orchestration example does with `tableName(ctx.db.namespace)`).

The migration file should use a placeholder schema name. Looking at the example, it hardcodes the full namespace. We'll follow the same pattern — the actual hash is deterministic from the plugin ID.

```sql
CREATE TABLE pipeline_runs (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL,
  parent_issue_id UUID NOT NULL,
  pipeline_name TEXT NOT NULL,
  pipeline_version INTEGER NOT NULL DEFAULT 1,
  pipeline_yaml TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_pipeline_runs_company ON pipeline_runs(company_id);
CREATE INDEX idx_pipeline_runs_parent_issue ON pipeline_runs(parent_issue_id);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(status) WHERE status = 'running';

CREATE TABLE pipeline_stages (
  id UUID PRIMARY KEY,
  pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL,
  sub_issue_id UUID,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  output JSONB,
  error TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_pipeline_stages_run ON pipeline_stages(pipeline_run_id);
CREATE INDEX idx_pipeline_stages_sub_issue ON pipeline_stages(sub_issue_id) WHERE sub_issue_id IS NOT NULL;
CREATE UNIQUE INDEX idx_pipeline_stages_run_stage ON pipeline_stages(pipeline_run_id, stage_id);

CREATE TABLE sub_pipeline_runs (
  id UUID PRIMARY KEY,
  parent_pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  parent_stage_id UUID NOT NULL REFERENCES pipeline_stages(id) ON DELETE CASCADE,
  child_pipeline_run_id UUID NOT NULL REFERENCES pipeline_runs(id) ON DELETE CASCADE,
  task_index INTEGER NOT NULL,
  ordering_position INTEGER NOT NULL
);

CREATE INDEX idx_sub_pipeline_parent ON sub_pipeline_runs(parent_pipeline_run_id);
CREATE INDEX idx_sub_pipeline_child ON sub_pipeline_runs(child_pipeline_run_id);
```

Note: The migration SQL uses bare table names. The plugin SDK creates these tables inside the plugin's namespaced schema (e.g., `plugin_pipeline_engine_<hash>`) at migration time. Runtime queries use `ctx.db.namespace` prefix as shown in the StateMachine implementation.

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/pipeline-engine/migrations/001_pipeline_tables.sql
git commit -m "feat(pipeline-engine): add database migration for pipeline tables"
```

---

## Chunk 2: DAG Parser & Expression Engine

### Task 5: Expression Engine (JSONata Wrapper)

**Files:**
- Create: `packages/plugins/pipeline-engine/src/expression-engine.ts`
- Create: `packages/plugins/pipeline-engine/src/tests/expression-engine.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { evaluateCondition, buildExpressionContext } from "../expression-engine.js";
import type { ExpressionContext, StageStatus } from "../types.js";

describe("expression-engine", () => {
  const baseContext: ExpressionContext = {
    stages: {
      "spec-review": { output: { status: "approved", completeness_score: 0.9 }, status: "completed", retry_count: 0 },
      validate: { output: { status: "pass" }, status: "completed", retry_count: 0 },
    },
    pipeline: { name: "feature", version: 1, parent_issue_id: "issue-1" },
    env: { company_id: "company-1" },
  };

  it("evaluates simple equality", async () => {
    const result = await evaluateCondition('stages."spec-review".output.status = \'approved\'', baseContext);
    expect(result).toBe(true);
  });

  it("evaluates false condition", async () => {
    const result = await evaluateCondition('stages."spec-review".output.status = \'rejected\'', baseContext);
    expect(result).toBe(false);
  });

  it("evaluates nested field access", async () => {
    const result = await evaluateCondition('stages.validate.output.status = \'pass\'', baseContext);
    expect(result).toBe(true);
  });

  it("returns false for missing stage", async () => {
    const result = await evaluateCondition('stages.nonexistent.output.status = \'pass\'', baseContext);
    expect(result).toBe(false);
  });

  it("throws on invalid expression syntax", async () => {
    await expect(evaluateCondition("invalid %%% syntax", baseContext)).rejects.toThrow();
  });

  describe("buildExpressionContext", () => {
    it("builds context from stage records", () => {
      const stages = [
        { stageId: "validate", status: "completed" as StageStatus, output: { status: "pass" }, retryCount: 1 },
      ];
      const ctx = buildExpressionContext(stages, "feature", 1, "issue-1", "company-1");
      expect(ctx.stages.validate.output).toEqual({ status: "pass" });
      expect(ctx.stages.validate.retry_count).toBe(1);
      expect(ctx.pipeline.name).toBe("feature");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugins/pipeline-engine && pnpm test`
Expected: FAIL — module not found

- [ ] **Step 3: Implement expression-engine.ts**

```typescript
import jsonata from "jsonata";
import type { ExpressionContext, PipelineStage, StageStatus } from "./types.js";

export async function evaluateCondition(expression: string, context: ExpressionContext): Promise<boolean> {
  const expr = jsonata(expression);
  const result = await expr.evaluate(context);
  return Boolean(result);
}

export function buildExpressionContext(
  stages: Pick<PipelineStage, "stageId" | "status" | "output" | "retryCount">[],
  pipelineName: string,
  pipelineVersion: number,
  parentIssueId: string,
  companyId: string,
): ExpressionContext {
  const stageMap: ExpressionContext["stages"] = {};
  for (const stage of stages) {
    stageMap[stage.stageId] = {
      output: (stage.output as Record<string, unknown>) ?? null,
      status: stage.status,
      retry_count: stage.retryCount,
    };
  }
  return {
    stages: stageMap,
    pipeline: { name: pipelineName, version: pipelineVersion, parent_issue_id: parentIssueId },
    env: { company_id: companyId },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/expression-engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pipeline-engine/src/expression-engine.ts packages/plugins/pipeline-engine/src/tests/expression-engine.test.ts
git commit -m "feat(pipeline-engine): add JSONata expression engine"
```

---

### Task 6: Template Engine (Handlebars Interpolation)

**Files:**
- Create: `packages/plugins/pipeline-engine/src/template-engine.ts`
- Create: `packages/plugins/pipeline-engine/src/tests/template-engine.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { renderTemplate } from "../template-engine.js";

describe("template-engine", () => {
  it("interpolates output fields", () => {
    const result = renderTemplate("Fix validation failures: {{ output.errors }}", {
      output: { errors: ["test failed", "lint error"] },
    });
    expect(result).toBe("Fix validation failures: test failed,lint error");
  });

  it("interpolates nested objects as JSON", () => {
    const result = renderTemplate("Findings: {{ output.findings }}", {
      output: { findings: [{ file: "a.ts", description: "issue" }] },
    });
    expect(result).toContain("a.ts");
  });

  it("handles missing fields gracefully", () => {
    const result = renderTemplate("Error: {{ output.missing }}", { output: {} });
    expect(result).toBe("Error: ");
  });

  it("passes through text without templates", () => {
    const result = renderTemplate("No templates here", { output: {} });
    expect(result).toBe("No templates here");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/template-engine.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement template-engine.ts**

```typescript
import Handlebars from "handlebars";

export function renderTemplate(template: string, context: Record<string, unknown>): string {
  const compiled = Handlebars.compile(template, { noEscape: true });
  return compiled(context);
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/template-engine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pipeline-engine/src/template-engine.ts packages/plugins/pipeline-engine/src/tests/template-engine.test.ts
git commit -m "feat(pipeline-engine): add Handlebars template engine"
```

---

### Task 7: DAG Parser

**Files:**
- Create: `packages/plugins/pipeline-engine/src/dag-parser.ts`
- Create: `packages/plugins/pipeline-engine/src/tests/dag-parser.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { parsePipeline, validateDAG } from "../dag-parser.js";
import type { PipelineDefinition } from "../types.js";

const validYaml = `
name: feature
description: Full feature development
trigger:
  label: "pipeline:feature"
stages:
  - id: spec-review
    type: classifier
    agent_role: spec-reviewer
    output_schema: spec-review-output
  - id: decompose
    type: classifier
    agent_role: decomposer
    depends_on: [spec-review]
    condition: "stages.\\"spec-review\\".output.status = 'approved'"
    output_schema: decomposition-output
    checkpoint: true
  - id: implement
    type: worker
    agent_role: code-writer
    depends_on: [decompose]
    output_schema: implementation-output
`;

describe("dag-parser", () => {
  describe("parsePipeline", () => {
    it("parses valid YAML into PipelineDefinition", () => {
      const result = parsePipeline(validYaml);
      expect(result.name).toBe("feature");
      expect(result.trigger.label).toBe("pipeline:feature");
      expect(result.stages).toHaveLength(3);
      expect(result.stages[1].depends_on).toEqual(["spec-review"]);
    });

    it("throws on invalid YAML", () => {
      expect(() => parsePipeline(":::invalid")).toThrow();
    });

    it("throws on missing required fields", () => {
      expect(() => parsePipeline("name: test\nstages: []")).toThrow();
    });
  });

  describe("validateDAG", () => {
    it("returns valid for acyclic graph", () => {
      const pipeline = parsePipeline(validYaml);
      const result = validateDAG(pipeline);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("detects cycles", () => {
      const cyclic: PipelineDefinition = {
        name: "cyclic",
        description: "test",
        trigger: { label: "test" },
        stages: [
          { id: "a", type: "worker", depends_on: ["b"] },
          { id: "b", type: "worker", depends_on: ["a"] },
        ],
      };
      const result = validateDAG(cyclic);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("cycle");
    });

    it("detects invalid depends_on references", () => {
      const badRef: PipelineDefinition = {
        name: "bad-ref",
        description: "test",
        trigger: { label: "test" },
        stages: [
          { id: "a", type: "worker", depends_on: ["nonexistent"] },
        ],
      };
      const result = validateDAG(badRef);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("nonexistent");
    });

    it("detects duplicate stage IDs", () => {
      const dupes: PipelineDefinition = {
        name: "dupes",
        description: "test",
        trigger: { label: "test" },
        stages: [
          { id: "a", type: "worker" },
          { id: "a", type: "classifier" },
        ],
      };
      const result = validateDAG(dupes);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("duplicate");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/dag-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement dag-parser.ts**

```typescript
import yaml from "js-yaml";
import type { PipelineDefinition, StageDefinition } from "./types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function parsePipeline(yamlContent: string): PipelineDefinition {
  const parsed = yaml.load(yamlContent) as Record<string, unknown>;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid YAML: expected an object");
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

  return {
    name: parsed.name as string,
    description: (parsed.description as string) ?? "",
    trigger: parsed.trigger as PipelineDefinition["trigger"],
    stages: parsed.stages as StageDefinition[],
  };
}

export function validateDAG(pipeline: PipelineDefinition): ValidationResult {
  const errors: string[] = [];
  const stageIds = new Set<string>();
  const allStages = flattenStages(pipeline.stages);

  for (const stage of allStages) {
    if (stageIds.has(stage.id)) {
      errors.push(`duplicate stage id: "${stage.id}"`);
    }
    stageIds.add(stage.id);
  }

  for (const stage of allStages) {
    if (stage.depends_on) {
      for (const dep of stage.depends_on) {
        if (!stageIds.has(dep)) {
          errors.push(`stage "${stage.id}" depends on nonexistent stage "${dep}"`);
        }
      }
    }
  }

  const cycleError = detectCycle(allStages);
  if (cycleError) {
    errors.push(cycleError);
  }

  return { valid: errors.length === 0, errors };
}

function flattenStages(stages: StageDefinition[]): StageDefinition[] {
  const result: StageDefinition[] = [];
  for (const stage of stages) {
    result.push(stage);
    if (stage.stages) {
      result.push(...flattenStages(stage.stages));
    }
  }
  return result;
}

function detectCycle(stages: StageDefinition[]): string | null {
  const adjacency = new Map<string, string[]>();
  for (const stage of stages) {
    adjacency.set(stage.id, stage.depends_on ?? []);
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function dfs(nodeId: string): boolean {
    if (inStack.has(nodeId)) return true;
    if (visited.has(nodeId)) return false;
    visited.add(nodeId);
    inStack.add(nodeId);
    for (const dep of adjacency.get(nodeId) ?? []) {
      if (dfs(dep)) return true;
    }
    inStack.delete(nodeId);
    return false;
  }

  for (const stage of stages) {
    if (dfs(stage.id)) {
      return `cycle detected involving stage "${stage.id}"`;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/dag-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pipeline-engine/src/dag-parser.ts packages/plugins/pipeline-engine/src/tests/dag-parser.test.ts
git commit -m "feat(pipeline-engine): add YAML DAG parser with validation"
```

---

## Chunk 3: Output Parser & Schema Validation

### Task 8: JSON Schema Files

**Files:**
- Create: `packages/plugins/pipeline-engine/schemas/spec-review-output.json`
- Create: `packages/plugins/pipeline-engine/schemas/decomposition-output.json`
- Create: `packages/plugins/pipeline-engine/schemas/implementation-output.json`
- Create: `packages/plugins/pipeline-engine/schemas/validation-output.json`
- Create: `packages/plugins/pipeline-engine/schemas/review-output.json`
- Create: `packages/plugins/pipeline-engine/schemas/merge-output.json`
- Create: `packages/plugins/pipeline-engine/schemas/classification-output.json`

- [ ] **Step 1: Create all schema files**

`schemas/spec-review-output.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["status"],
  "properties": {
    "status": { "type": "string", "enum": ["approved", "needs_revision", "rejected"] },
    "completeness_score": { "type": "number", "minimum": 0, "maximum": 1 },
    "gaps": { "type": "array", "items": { "type": "string" } },
    "recommendations": { "type": "array", "items": { "type": "string" } }
  },
  "additionalProperties": false
}
```

`schemas/decomposition-output.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tasks"],
  "properties": {
    "tasks": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "title", "body", "track", "component"],
        "properties": {
          "id": { "type": "string" },
          "title": { "type": "string" },
          "body": { "type": "string" },
          "track": { "type": "string", "enum": ["feature", "bug", "fast-track"] },
          "component": { "type": "string", "enum": ["backend", "frontend", "infra"] },
          "dependencies": { "type": "array", "items": { "type": "string" } },
          "estimated_complexity": { "type": "string", "enum": ["small", "medium", "large"] }
        }
      }
    },
    "rationale": { "type": "string" }
  },
  "additionalProperties": false
}
```

`schemas/implementation-output.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["status", "files_changed", "branch", "summary"],
  "properties": {
    "status": { "type": "string", "enum": ["complete", "blocked", "partial"] },
    "files_changed": { "type": "array", "items": { "type": "string" } },
    "branch": { "type": "string" },
    "summary": { "type": "string" },
    "blockers": { "type": "array", "items": { "type": "string" } }
  },
  "additionalProperties": false
}
```

`schemas/validation-output.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["status", "test_results", "lint_status", "type_check_status"],
  "properties": {
    "status": { "type": "string", "enum": ["pass", "fail"] },
    "test_results": {
      "type": "object",
      "required": ["passed", "failed", "skipped"],
      "properties": {
        "passed": { "type": "integer" },
        "failed": { "type": "integer" },
        "skipped": { "type": "integer" }
      }
    },
    "lint_status": { "type": "string", "enum": ["pass", "fail"] },
    "type_check_status": { "type": "string", "enum": ["pass", "fail"] },
    "errors": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["type", "file", "message"],
        "properties": {
          "type": { "type": "string", "enum": ["test_failure", "lint", "type_error"] },
          "file": { "type": "string" },
          "message": { "type": "string" }
        }
      }
    }
  },
  "additionalProperties": false
}
```

`schemas/review-output.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["decision", "summary"],
  "properties": {
    "decision": { "type": "string", "enum": ["approve", "request_changes", "block"] },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["file", "line", "category", "severity", "description"],
        "properties": {
          "file": { "type": "string" },
          "line": { "type": "integer" },
          "category": { "type": "string", "enum": ["security", "performance", "correctness", "style"] },
          "severity": { "type": "string", "enum": ["low", "medium", "high", "critical"] },
          "description": { "type": "string" },
          "suggestion": { "type": "string" }
        }
      }
    },
    "summary": { "type": "string" }
  },
  "additionalProperties": false
}
```

`schemas/merge-output.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["status"],
  "properties": {
    "status": { "type": "string", "enum": ["merged", "failed", "blocked"] },
    "pr_url": { "type": "string" },
    "merge_sha": { "type": "string" },
    "failure_reason": { "type": ["string", "null"] }
  },
  "additionalProperties": false
}
```

`schemas/classification-output.json`:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["classification", "confidence"],
  "properties": {
    "classification": { "type": "string" },
    "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
    "reasoning": { "type": "string" },
    "context": { "type": "object" }
  },
  "additionalProperties": false
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugins/pipeline-engine/schemas/
git commit -m "feat(pipeline-engine): add JSON Schema output definitions"
```

---

### Task 9: Output Parser

**Files:**
- Create: `packages/plugins/pipeline-engine/src/output-parser.ts`
- Create: `packages/plugins/pipeline-engine/src/tests/output-parser.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";
import { extractOutput, loadSchema, setSchemasDir, validateOutput } from "../output-parser.js";

describe("output-parser", () => {
  beforeAll(() => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    setSchemasDir(resolve(__dirname, "../../schemas"));
  });
  describe("extractOutput", () => {
    it("extracts JSON from sentinel-marked comment", () => {
      const body = `Some discussion here.

<!-- pipeline-output -->
\`\`\`json
{ "status": "pass", "test_results": { "passed": 5, "failed": 0, "skipped": 1 }, "lint_status": "pass", "type_check_status": "pass" }
\`\`\`

Some more text.`;
      const result = extractOutput(body);
      expect(result).not.toBeNull();
      expect(result!.status).toBe("pass");
    });

    it("returns null for comment without sentinel", () => {
      const body = `\`\`\`json\n{ "status": "pass" }\n\`\`\``;
      const result = extractOutput(body);
      expect(result).toBeNull();
    });

    it("returns null for invalid JSON after sentinel", () => {
      const body = `<!-- pipeline-output -->\n\`\`\`json\n{ invalid json }\n\`\`\``;
      const result = extractOutput(body);
      expect(result).toBeNull();
    });

    it("handles multiline JSON", () => {
      const body = `<!-- pipeline-output -->
\`\`\`json
{
  "status": "complete",
  "files_changed": ["src/a.ts", "src/b.ts"],
  "branch": "feat/pipeline",
  "summary": "Added pipeline"
}
\`\`\``;
      const result = extractOutput(body);
      expect(result).not.toBeNull();
      expect(result!.files_changed).toHaveLength(2);
    });
  });

  describe("validateOutput", () => {
    it("validates against schema", () => {
      const schema = loadSchema("validation-output");
      const data = {
        status: "pass",
        test_results: { passed: 5, failed: 0, skipped: 0 },
        lint_status: "pass",
        type_check_status: "pass",
      };
      const result = validateOutput(data, schema);
      expect(result.valid).toBe(true);
    });

    it("rejects invalid data", () => {
      const schema = loadSchema("validation-output");
      const data = { status: "invalid_value" };
      const result = validateOutput(data, schema);
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/output-parser.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement output-parser.ts**

```typescript
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import type { ParsedOutput } from "./types.js";

const SENTINEL = "<!-- pipeline-output -->";
const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)\n```/;

const ajv = new Ajv({ allErrors: true });
const schemaCache = new Map<string, object>();

export function extractOutput(commentBody: string): Record<string, unknown> | null {
  const sentinelIdx = commentBody.indexOf(SENTINEL);
  if (sentinelIdx === -1) return null;

  const afterSentinel = commentBody.slice(sentinelIdx + SENTINEL.length);
  const match = afterSentinel.match(JSON_FENCE_RE);
  if (!match) return null;

  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

let schemasBaseDir: string | undefined;

export function setSchemasDir(dir: string): void {
  schemasBaseDir = dir;
}

export function loadSchema(schemaName: string): object {
  if (schemaCache.has(schemaName)) return schemaCache.get(schemaName)!;

  const baseDir = schemasBaseDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "schemas");
  const schemaPath = resolve(baseDir, `${schemaName}.json`);
  const schema = JSON.parse(readFileSync(schemaPath, "utf-8")) as object;
  schemaCache.set(schemaName, schema);
  return schema;
}

export function validateOutput(
  data: Record<string, unknown>,
  schema: object,
): ParsedOutput {
  const validate = ajv.compile(schema);
  const valid = validate(data);

  if (valid) {
    return { valid: true, data };
  }

  const errorMessages = validate.errors?.map((e) => `${e.instancePath} ${e.message}`).join("; ") ?? "unknown error";
  return { valid: false, data: null, error: errorMessages };
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/output-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pipeline-engine/src/output-parser.ts packages/plugins/pipeline-engine/src/tests/output-parser.test.ts
git commit -m "feat(pipeline-engine): add output parser with sentinel detection and schema validation"
```

---

## Chunk 4: State Machine & Trigger Matcher

### Task 10: State Machine (DB Operations)

**Files:**
- Create: `packages/plugins/pipeline-engine/src/state-machine.ts`
- Create: `packages/plugins/pipeline-engine/src/tests/state-machine.test.ts`

- [ ] **Step 1: Write failing tests**

These tests mock `ctx.db` to verify correct SQL generation and state transitions:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { StateMachine } from "../state-machine.js";
import type { PipelineRunStatus, StageStatus } from "../types.js";

function createMockDb(namespace: string) {
  return {
    namespace,
    query: vi.fn().mockResolvedValue([]),
    execute: vi.fn().mockResolvedValue(undefined),
  };
}

describe("state-machine", () => {
  let db: ReturnType<typeof createMockDb>;
  let sm: StateMachine;

  beforeEach(() => {
    db = createMockDb("plugin_pipeline_engine_abc123");
    sm = new StateMachine(db);
  });

  describe("createRun", () => {
    it("inserts a pipeline run record", async () => {
      await sm.createRun({
        id: "run-1",
        companyId: "company-1",
        parentIssueId: "issue-1",
        pipelineName: "feature",
        pipelineVersion: 1,
        pipelineYaml: "yaml-content",
      });
      expect(db.execute).toHaveBeenCalledOnce();
      const sql = db.execute.mock.calls[0][0] as string;
      expect(sql).toContain("pipeline_runs");
      expect(sql).toContain("INSERT");
    });
  });

  describe("updateRunStatus", () => {
    it("updates the run status", async () => {
      await sm.updateRunStatus("run-1", "completed");
      expect(db.execute).toHaveBeenCalledOnce();
      const sql = db.execute.mock.calls[0][0] as string;
      expect(sql).toContain("UPDATE");
      expect(sql).toContain("pipeline_runs");
    });
  });

  describe("createStage", () => {
    it("inserts a stage record", async () => {
      await sm.createStage({
        id: "stage-1",
        pipelineRunId: "run-1",
        stageId: "spec-review",
      });
      expect(db.execute).toHaveBeenCalledOnce();
      const sql = db.execute.mock.calls[0][0] as string;
      expect(sql).toContain("pipeline_stages");
    });
  });

  describe("updateStageStatus", () => {
    it("sets status and timestamps", async () => {
      await sm.updateStageStatus("stage-1", "running");
      const sql = db.execute.mock.calls[0][0] as string;
      expect(sql).toContain("started_at");
    });

    it("sets completed_at for terminal states", async () => {
      await sm.updateStageStatus("stage-1", "completed");
      const sql = db.execute.mock.calls[0][0] as string;
      expect(sql).toContain("completed_at");
    });
  });

  describe("setStageOutput", () => {
    it("stores parsed output JSON", async () => {
      await sm.setStageOutput("stage-1", { status: "pass" });
      const params = db.execute.mock.calls[0][1] as unknown[];
      expect(JSON.parse(params[0] as string)).toEqual({ status: "pass" });
    });
  });

  describe("incrementRetryCount", () => {
    it("increments and returns new count", async () => {
      db.query.mockResolvedValueOnce([{ retry_count: 2 }]);
      const count = await sm.incrementRetryCount("stage-1");
      expect(count).toBe(2);
    });
  });

  describe("getRunStages", () => {
    it("queries stages for a run", async () => {
      db.query.mockResolvedValueOnce([
        { id: "s1", stage_id: "spec-review", status: "completed", output: null, retry_count: 0 },
      ]);
      const stages = await sm.getRunStages("run-1");
      expect(stages).toHaveLength(1);
      expect(stages[0].stageId).toBe("spec-review");
    });
  });

  describe("getActiveRunForIssue", () => {
    it("returns null if no active run", async () => {
      db.query.mockResolvedValueOnce([]);
      const run = await sm.getActiveRunForIssue("issue-1", "company-1");
      expect(run).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/state-machine.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement state-machine.ts**

```typescript
import type { PipelineRun, PipelineRunStatus, PipelineStage, StageStatus } from "./types.js";

interface DbClient {
  namespace: string;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
}

export class StateMachine {
  private db: DbClient;

  constructor(db: DbClient) {
    this.db = db;
  }

  private table(name: string): string {
    return `${this.db.namespace}.${name}`;
  }

  async createRun(input: {
    id: string;
    companyId: string;
    parentIssueId: string;
    pipelineName: string;
    pipelineVersion: number;
    pipelineYaml: string;
  }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.table("pipeline_runs")} (id, company_id, parent_issue_id, pipeline_name, pipeline_version, pipeline_yaml)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [input.id, input.companyId, input.parentIssueId, input.pipelineName, input.pipelineVersion, input.pipelineYaml],
    );
  }

  async updateRunStatus(runId: string, status: PipelineRunStatus): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("pipeline_runs")} SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, runId],
    );
  }

  async createStage(input: { id: string; pipelineRunId: string; stageId: string }): Promise<void> {
    await this.db.execute(
      `INSERT INTO ${this.table("pipeline_stages")} (id, pipeline_run_id, stage_id)
       VALUES ($1, $2, $3)`,
      [input.id, input.pipelineRunId, input.stageId],
    );
  }

  async updateStageStatus(stageRowId: string, status: StageStatus): Promise<void> {
    const isStarting = status === "running";
    const isTerminal = status === "completed" || status === "failed" || status === "skipped";

    let sql = `UPDATE ${this.table("pipeline_stages")} SET status = $1`;
    if (isStarting) sql += `, started_at = NOW()`;
    if (isTerminal) sql += `, completed_at = NOW()`;
    sql += ` WHERE id = $2`;

    await this.db.execute(sql, [status, stageRowId]);
  }

  async setStageOutput(stageRowId: string, output: Record<string, unknown>): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("pipeline_stages")} SET output = $1::jsonb WHERE id = $2`,
      [JSON.stringify(output), stageRowId],
    );
  }

  async setStageError(stageRowId: string, error: string): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("pipeline_stages")} SET error = $1 WHERE id = $2`,
      [error, stageRowId],
    );
  }

  async incrementRetryCount(stageRowId: string): Promise<number> {
    const rows = await this.db.query<{ retry_count: number }>(
      `UPDATE ${this.table("pipeline_stages")} SET retry_count = retry_count + 1, status = 'pending', started_at = NULL, completed_at = NULL
       RETURNING retry_count`,
      [stageRowId],
    );
    return rows[0]?.retry_count ?? 0;
  }

  async resetDownstreamStages(pipelineRunId: string, afterStageId: string, allStages: string[], adjacency: Map<string, string[]>): Promise<void> {
    const downstream = this.getDownstreamStageIds(afterStageId, allStages, adjacency);
    if (downstream.length === 0) return;

    const placeholders = downstream.map((_, i) => `$${i + 2}`).join(", ");
    await this.db.execute(
      `UPDATE ${this.table("pipeline_stages")} SET status = 'pending', output = NULL, error = NULL, started_at = NULL, completed_at = NULL
       WHERE pipeline_run_id = $1 AND stage_id IN (${placeholders})`,
      [pipelineRunId, ...downstream],
    );
  }

  private getDownstreamStageIds(afterStageId: string, allStageIds: string[], adjacency: Map<string, string[]>): string[] {
    const downstream = new Set<string>();
    const queue = [afterStageId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const stageId of allStageIds) {
        if (downstream.has(stageId)) continue;
        const deps = adjacency.get(stageId) ?? [];
        if (deps.includes(current)) {
          downstream.add(stageId);
          queue.push(stageId);
        }
      }
    }
    return [...downstream];
  }

  async getRunStages(pipelineRunId: string): Promise<PipelineStage[]> {
    const rows = await this.db.query<{
      id: string;
      pipeline_run_id: string;
      stage_id: string;
      sub_issue_id: string | null;
      status: StageStatus;
      retry_count: number;
      output: Record<string, unknown> | null;
      error: string | null;
      started_at: string | null;
      completed_at: string | null;
    }>(
      `SELECT id, pipeline_run_id, stage_id, sub_issue_id, status, retry_count, output, error, started_at, completed_at
       FROM ${this.table("pipeline_stages")} WHERE pipeline_run_id = $1`,
      [pipelineRunId],
    );

    return rows.map((r) => ({
      id: r.id,
      pipelineRunId: r.pipeline_run_id,
      stageId: r.stage_id,
      subIssueId: r.sub_issue_id,
      status: r.status,
      retryCount: r.retry_count,
      output: r.output,
      error: r.error,
      startedAt: r.started_at ? new Date(r.started_at) : null,
      completedAt: r.completed_at ? new Date(r.completed_at) : null,
    }));
  }

  async getActiveRunForIssue(parentIssueId: string, companyId: string): Promise<PipelineRun | null> {
    const rows = await this.db.query<{
      id: string;
      company_id: string;
      parent_issue_id: string;
      pipeline_name: string;
      pipeline_version: number;
      pipeline_yaml: string;
      status: PipelineRunStatus;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT * FROM ${this.table("pipeline_runs")}
       WHERE parent_issue_id = $1 AND company_id = $2 AND status = 'running'
       LIMIT 1`,
      [parentIssueId, companyId],
    );

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      companyId: r.company_id,
      parentIssueId: r.parent_issue_id,
      pipelineName: r.pipeline_name,
      pipelineVersion: r.pipeline_version,
      pipelineYaml: r.pipeline_yaml,
      status: r.status,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }

  async getStageBySubIssueId(subIssueId: string): Promise<(PipelineStage & { pipelineRunId: string }) | null> {
    const rows = await this.db.query<{
      id: string;
      pipeline_run_id: string;
      stage_id: string;
      sub_issue_id: string | null;
      status: StageStatus;
      retry_count: number;
      output: Record<string, unknown> | null;
      error: string | null;
      started_at: string | null;
      completed_at: string | null;
    }>(
      `SELECT * FROM ${this.table("pipeline_stages")} WHERE sub_issue_id = $1 LIMIT 1`,
      [subIssueId],
    );

    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      pipelineRunId: r.pipeline_run_id,
      stageId: r.stage_id,
      subIssueId: r.sub_issue_id,
      status: r.status,
      retryCount: r.retry_count,
      output: r.output,
      error: r.error,
      startedAt: r.started_at ? new Date(r.started_at) : null,
      completedAt: r.completed_at ? new Date(r.completed_at) : null,
    };
  }

  async setStageSubIssueId(stageRowId: string, subIssueId: string): Promise<void> {
    await this.db.execute(
      `UPDATE ${this.table("pipeline_stages")} SET sub_issue_id = $1 WHERE id = $2`,
      [subIssueId, stageRowId],
    );
  }

  async getRun(runId: string): Promise<PipelineRun | null> {
    const rows = await this.db.query<{
      id: string;
      company_id: string;
      parent_issue_id: string;
      pipeline_name: string;
      pipeline_version: number;
      pipeline_yaml: string;
      status: PipelineRunStatus;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT * FROM ${this.table("pipeline_runs")} WHERE id = $1 LIMIT 1`,
      [runId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id,
      companyId: r.company_id,
      parentIssueId: r.parent_issue_id,
      pipelineName: r.pipeline_name,
      pipelineVersion: r.pipeline_version,
      pipelineYaml: r.pipeline_yaml,
      status: r.status,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/state-machine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pipeline-engine/src/state-machine.ts packages/plugins/pipeline-engine/src/tests/state-machine.test.ts
git commit -m "feat(pipeline-engine): add state machine for pipeline/stage persistence"
```

---

### Task 11: Trigger Matcher

**Files:**
- Create: `packages/plugins/pipeline-engine/src/trigger-matcher.ts`
- Create: `packages/plugins/pipeline-engine/src/tests/trigger-matcher.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import { TriggerMatcher } from "../trigger-matcher.js";
import type { PipelineDefinition } from "../types.js";

describe("trigger-matcher", () => {
  const pipelines: PipelineDefinition[] = [
    { name: "feature", description: "", trigger: { label: "pipeline:feature" }, stages: [] },
    { name: "bug", description: "", trigger: { label: "pipeline:bug" }, stages: [] },
  ];

  it("matches a trigger label to a pipeline", () => {
    const matcher = new TriggerMatcher(pipelines);
    const result = matcher.match(["pipeline:feature", "priority:high"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("feature");
  });

  it("returns null when no label matches", () => {
    const matcher = new TriggerMatcher(pipelines);
    const result = matcher.match(["priority:high", "team:backend"]);
    expect(result).toBeNull();
  });

  it("returns first match when multiple labels match", () => {
    const matcher = new TriggerMatcher(pipelines);
    const result = matcher.match(["pipeline:bug", "pipeline:feature"]);
    expect(result).not.toBeNull();
  });

  it("handles empty label array", () => {
    const matcher = new TriggerMatcher(pipelines);
    const result = matcher.match([]);
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/trigger-matcher.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement trigger-matcher.ts**

```typescript
import type { PipelineDefinition } from "./types.js";

export class TriggerMatcher {
  private labelToPipeline: Map<string, PipelineDefinition>;

  constructor(pipelines: PipelineDefinition[]) {
    this.labelToPipeline = new Map();
    for (const pipeline of pipelines) {
      this.labelToPipeline.set(pipeline.trigger.label, pipeline);
    }
  }

  match(labelNames: string[]): PipelineDefinition | null {
    for (const label of labelNames) {
      const pipeline = this.labelToPipeline.get(label);
      if (pipeline) return pipeline;
    }
    return null;
  }

  hasTriggerLabel(labelName: string): boolean {
    return this.labelToPipeline.has(labelName);
  }

  get triggerLabels(): string[] {
    return [...this.labelToPipeline.keys()];
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/trigger-matcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pipeline-engine/src/trigger-matcher.ts packages/plugins/pipeline-engine/src/tests/trigger-matcher.test.ts
git commit -m "feat(pipeline-engine): add trigger matcher for label-to-pipeline resolution"
```

---

## Chunk 5: Dispatcher & Router

### Task 12: Dispatcher

**Files:**
- Create: `packages/plugins/pipeline-engine/src/dispatcher.ts`
- Create: `packages/plugins/pipeline-engine/src/tests/dispatcher.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Dispatcher } from "../dispatcher.js";
import type { RoleMapping, StageDefinition } from "../types.js";

function createMockIssuesClient() {
  return {
    create: vi.fn().mockResolvedValue({ id: "new-issue-1" }),
    update: vi.fn().mockResolvedValue(undefined),
    requestWakeup: vi.fn().mockResolvedValue({ queued: true }),
    createComment: vi.fn().mockResolvedValue(undefined),
    documents: {
      upsert: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("dispatcher", () => {
  let issues: ReturnType<typeof createMockIssuesClient>;
  let dispatcher: Dispatcher;
  const roleMapping: RoleMapping = {
    "code-writer": "agent-uuid-1",
    "spec-reviewer": "agent-uuid-2",
  };

  beforeEach(() => {
    issues = createMockIssuesClient();
    dispatcher = new Dispatcher(issues as any, roleMapping, "paperclipai.pipeline-engine");
  });

  it("creates a sub-issue for a worker stage", async () => {
    const stage: StageDefinition = { id: "implement", type: "worker", agent_role: "code-writer" };
    const result = await dispatcher.dispatch({
      pipelineRunId: "run-1",
      stage,
      companyId: "company-1",
      parentIssueId: "parent-1",
    });
    expect(issues.create).toHaveBeenCalledOnce();
    const createCall = issues.create.mock.calls[0][0];
    expect(createCall.assigneeAgentId).toBe("agent-uuid-1");
    expect(createCall.parentId).toBe("parent-1");
    expect(result.issueId).toBe("new-issue-1");
  });

  it("throws CONFIGURATION_ERROR for unknown role", async () => {
    const stage: StageDefinition = { id: "unknown", type: "worker", agent_role: "nonexistent-role" };
    await expect(
      dispatcher.dispatch({ pipelineRunId: "run-1", stage, companyId: "company-1", parentIssueId: "parent-1" }),
    ).rejects.toThrow("CONFIGURATION_ERROR");
  });

  it("requests wakeup after creating issue", async () => {
    const stage: StageDefinition = { id: "review", type: "classifier", agent_role: "spec-reviewer" };
    await dispatcher.dispatch({ pipelineRunId: "run-1", stage, companyId: "company-1", parentIssueId: "parent-1" });
    expect(issues.requestWakeup).toHaveBeenCalledOnce();
  });

  it("includes failure context in retry dispatch", async () => {
    const stage: StageDefinition = { id: "implement", type: "worker", agent_role: "code-writer" };
    await dispatcher.dispatch({
      pipelineRunId: "run-1",
      stage,
      companyId: "company-1",
      parentIssueId: "parent-1",
      context: "Fix validation failures: test_a failed",
    });
    const createCall = issues.create.mock.calls[0][0];
    expect(createCall.description).toContain("Fix validation failures");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/dispatcher.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement dispatcher.ts**

```typescript
import type { DispatchRequest, RoleMapping } from "./types.js";

interface IssuesClient {
  create(input: Record<string, unknown>): Promise<{ id: string }>;
  requestWakeup(issueId: string, companyId: string, options: Record<string, unknown>): Promise<{ queued: boolean }>;
  documents: {
    upsert(input: Record<string, unknown>): Promise<void>;
  };
}

export interface DispatchResult {
  issueId: string;
  wakeupQueued: boolean;
}

export class Dispatcher {
  constructor(
    private issues: IssuesClient,
    private roleMapping: RoleMapping,
    private pluginId: string,
  ) {}

  async dispatch(request: DispatchRequest): Promise<DispatchResult> {
    const { pipelineRunId, stage, companyId, parentIssueId, context } = request;

    if (stage.agent_role && !this.roleMapping[stage.agent_role]) {
      throw new Error(`CONFIGURATION_ERROR: no agent mapped for role "${stage.agent_role}"`);
    }

    const agentId = stage.agent_role ? this.roleMapping[stage.agent_role] : undefined;

    const description = context
      ? `## Pipeline Stage: ${stage.id}\n\n${context}`
      : `## Pipeline Stage: ${stage.id}`;

    const issue = await this.issues.create({
      companyId,
      parentId: parentIssueId,
      inheritExecutionWorkspaceFromIssueId: parentIssueId,
      title: `[pipeline] ${stage.id}`,
      description,
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      billingCode: `plugin:pipeline-engine:${pipelineRunId}`,
      originKind: `plugin:${this.pluginId}:stage`,
      originId: `${pipelineRunId}:${stage.id}`,
    });

    const wakeup = await this.issues.requestWakeup(issue.id, companyId, {
      reason: `plugin:pipeline-engine:${stage.id}`,
      contextSource: "plugin-pipeline-engine",
      idempotencyKey: `${pipelineRunId}:${stage.id}:${Date.now()}`,
    });

    return { issueId: issue.id, wakeupQueued: wakeup.queued };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/dispatcher.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pipeline-engine/src/dispatcher.ts packages/plugins/pipeline-engine/src/tests/dispatcher.test.ts
git commit -m "feat(pipeline-engine): add dispatcher for sub-issue creation and agent assignment"
```

---

### Task 13: Router

**Files:**
- Create: `packages/plugins/pipeline-engine/src/router.ts`
- Create: `packages/plugins/pipeline-engine/src/tests/router.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { Router } from "../router.js";
import type { PipelineDefinition, PipelineStage, StageDefinition, StageStatus } from "../types.js";

const featurePipeline: PipelineDefinition = {
  name: "feature",
  description: "",
  trigger: { label: "pipeline:feature" },
  stages: [
    { id: "spec-review", type: "classifier", agent_role: "spec-reviewer", output_schema: "spec-review-output" },
    {
      id: "decompose",
      type: "classifier",
      agent_role: "decomposer",
      depends_on: ["spec-review"],
      condition: 'stages."spec-review".output.status = \'approved\'',
    },
    { id: "implement", type: "worker", agent_role: "code-writer", depends_on: ["decompose"] },
    {
      id: "validate",
      type: "worker",
      agent_role: "validator",
      depends_on: ["implement"],
      on_failure: { retry_with: { goto: "implement", body: "Fix: {{ output.errors }}", max_retries: 3 } },
    },
  ],
};

function makeStage(stageId: string, status: StageStatus, output?: Record<string, unknown>): PipelineStage {
  return {
    id: `row-${stageId}`,
    pipelineRunId: "run-1",
    stageId,
    subIssueId: null,
    status,
    retryCount: 0,
    output: output ?? null,
    error: null,
    startedAt: null,
    completedAt: null,
  };
}

describe("router", () => {
  const router = new Router();

  describe("getReadyStages", () => {
    it("returns root stages when nothing has run", async () => {
      const stages = [makeStage("spec-review", "pending")];
      const ready = await router.getReadyStages(featurePipeline, stages, "company-1");
      expect(ready.map((s) => s.id)).toContain("spec-review");
    });

    it("returns next stage when dependencies are complete", async () => {
      const stages = [
        makeStage("spec-review", "completed", { status: "approved" }),
        makeStage("decompose", "pending"),
      ];
      const ready = await router.getReadyStages(featurePipeline, stages, "company-1");
      expect(ready.map((s) => s.id)).toContain("decompose");
    });

    it("skips stage when condition is false", async () => {
      const stages = [
        makeStage("spec-review", "completed", { status: "rejected" }),
        makeStage("decompose", "pending"),
      ];
      const ready = await router.getReadyStages(featurePipeline, stages, "company-1");
      expect(ready.map((s) => s.id)).not.toContain("decompose");
    });

    it("does not return already-running stages", async () => {
      const stages = [makeStage("spec-review", "running")];
      const ready = await router.getReadyStages(featurePipeline, stages, "company-1");
      expect(ready).toHaveLength(0);
    });
  });

  describe("evaluateFailure", () => {
    it("returns goto action when target retry count is below max", () => {
      const stageDef = featurePipeline.stages[3]; // validate
      const stageRow = makeStage("validate", "failed");
      stageRow.output = { errors: ["test failed"] };
      // Target stage (implement) has 0 retries — should allow goto
      const targetRow = makeStage("implement", "completed");
      targetRow.retryCount = 0;
      const result = router.evaluateFailure(stageDef, stageRow, targetRow);
      expect(result.action).toBe("goto");
      expect(result.targetStageId).toBe("implement");
      expect(result.body).toContain("test failed");
    });

    it("returns escalate when target stage max retries exceeded", () => {
      const stageDef = featurePipeline.stages[3];
      const stageRow = makeStage("validate", "failed");
      stageRow.output = { errors: [] };
      // Target stage (implement) has hit max retries (3)
      const targetRow = makeStage("implement", "completed");
      targetRow.retryCount = 3;
      const result = router.evaluateFailure(stageDef, stageRow, targetRow);
      expect(result.action).toBe("escalate");
    });

    it("falls back to source stage retry count when no target provided", () => {
      const stageDef = featurePipeline.stages[3];
      const stageRow = makeStage("validate", "failed");
      stageRow.retryCount = 3;
      stageRow.output = { errors: [] };
      const result = router.evaluateFailure(stageDef, stageRow);
      expect(result.action).toBe("escalate");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/router.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement router.ts**

```typescript
import { evaluateCondition, buildExpressionContext } from "./expression-engine.js";
import { renderTemplate } from "./template-engine.js";
import type { PipelineDefinition, PipelineStage, StageDefinition } from "./types.js";

export interface FailureAction {
  action: "goto" | "escalate";
  targetStageId?: string;
  body?: string;
}

export class Router {
  async getReadyStages(
    pipeline: PipelineDefinition,
    stageRows: PipelineStage[],
    companyId: string,
  ): Promise<StageDefinition[]> {
    const stageStatusMap = new Map(stageRows.map((s) => [s.stageId, s]));
    const ready: StageDefinition[] = [];

    // Check if any completed dependency has checkpoint: true and its downstream
    // stages haven't been dynamically created yet — if so, don't advance past it
    for (const stageDef of pipeline.stages) {
      const row = stageStatusMap.get(stageDef.id);
      if (!row || row.status !== "pending") continue;

      // Sub-pipeline stages cannot be dispatched directly — they require
      // dynamic materialization from a checkpoint stage's output
      if (stageDef.type === "sub-pipeline") continue;

      // Parallel fan-out stages require recursive handling of nested stages
      if (stageDef.type === "parallel_fan_out") continue;

      const depsComplete = (stageDef.depends_on ?? []).every((dep) => {
        const depRow = stageStatusMap.get(dep);
        return depRow?.status === "completed";
      });
      if (!depsComplete) continue;

      // Check if any dependency is a checkpoint stage — if so, the engine
      // pauses to dynamically plan downstream (e.g., create sub-pipelines
      // from decomposer output). Skip until checkpoint processing is done.
      const blockedByCheckpoint = (stageDef.depends_on ?? []).some((dep) => {
        const depDef = pipeline.stages.find((s) => s.id === dep);
        return depDef?.checkpoint === true;
      });
      if (blockedByCheckpoint) {
        // Checkpoint processing is handled separately by handleCheckpointCompletion
        continue;
      }

      // Evaluate skip_if — if true, mark stage as skipped
      if (stageDef.skip_if) {
        const context = buildExpressionContext(
          stageRows.map((s) => ({ stageId: s.stageId, status: s.status, output: s.output, retryCount: s.retryCount })),
          pipeline.name,
          1,
          "",
          companyId,
        );
        const shouldSkip = await evaluateCondition(stageDef.skip_if, context);
        if (shouldSkip) continue; // Caller should mark as skipped
      }

      if (stageDef.condition) {
        const context = buildExpressionContext(
          stageRows.map((s) => ({ stageId: s.stageId, status: s.status, output: s.output, retryCount: s.retryCount })),
          pipeline.name,
          1,
          "",
          companyId,
        );
        const conditionMet = await evaluateCondition(stageDef.condition, context);
        if (!conditionMet) continue;
      }

      ready.push(stageDef);
    }

    return ready;
  }

  /**
   * Returns stages that should be marked as skipped (skip_if evaluated to true).
   */
  async getSkippedStages(
    pipeline: PipelineDefinition,
    stageRows: PipelineStage[],
    companyId: string,
  ): Promise<StageDefinition[]> {
    const stageStatusMap = new Map(stageRows.map((s) => [s.stageId, s]));
    const skipped: StageDefinition[] = [];

    for (const stageDef of pipeline.stages) {
      const row = stageStatusMap.get(stageDef.id);
      if (!row || row.status !== "pending") continue;
      if (!stageDef.skip_if) continue;

      const depsComplete = (stageDef.depends_on ?? []).every((dep) => {
        const depRow = stageStatusMap.get(dep);
        return depRow?.status === "completed" || depRow?.status === "skipped";
      });
      if (!depsComplete) continue;

      const context = buildExpressionContext(
        stageRows.map((s) => ({ stageId: s.stageId, status: s.status, output: s.output, retryCount: s.retryCount })),
        pipeline.name,
        1,
        "",
        companyId,
      );
      const shouldSkip = await evaluateCondition(stageDef.skip_if, context);
      if (shouldSkip) skipped.push(stageDef);
    }

    return skipped;
  }

  /**
   * Evaluates failure for a stage. Uses the TARGET stage's retry count
   * (not the failing stage's) to determine whether retries are exhausted.
   */
  evaluateFailure(
    stageDef: StageDefinition,
    stageRow: PipelineStage,
    targetStageRow?: PipelineStage,
  ): FailureAction {
    const onFailure = stageDef.on_failure;
    if (!onFailure?.retry_with) {
      return { action: "escalate" };
    }

    const { goto, body, max_retries } = onFailure.retry_with;

    // Check the TARGET stage's retry count — the target is what gets retried
    const retryCount = targetStageRow?.retryCount ?? stageRow.retryCount;
    if (retryCount >= max_retries) {
      return { action: "escalate" };
    }

    const renderedBody = renderTemplate(body, { output: stageRow.output ?? {} });
    return { action: "goto", targetStageId: goto, body: renderedBody };
  }

  /**
   * Checks if a stage type requires agent dispatch (vs engine-only handling).
   */
  requiresAgentDispatch(stageDef: StageDefinition): boolean {
    return stageDef.type === "worker" || stageDef.type === "classifier";
  }
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/plugins/pipeline-engine && pnpm test -- src/tests/router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/plugins/pipeline-engine/src/router.ts packages/plugins/pipeline-engine/src/tests/router.test.ts
git commit -m "feat(pipeline-engine): add router for DAG traversal and failure handling"
```

---

## Chunk 6: Plugin Worker (Event Wiring)

### Task 14: Worker Entry Point

**Files:**
- Create: `packages/plugins/pipeline-engine/src/worker.ts`

This is the main integration file that wires all components together via the plugin SDK's event system.

- [ ] **Step 1: Implement worker.ts**

```typescript
import { randomUUID } from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginApiRequestInput,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import { parsePipeline, validateDAG } from "./dag-parser.js";
import { Dispatcher } from "./dispatcher.js";
import { evaluateCondition, buildExpressionContext } from "./expression-engine.js";
import { extractOutput, loadSchema, validateOutput } from "./output-parser.js";
import { Router } from "./router.js";
import { StateMachine } from "./state-machine.js";
import { TriggerMatcher } from "./trigger-matcher.js";
import type { PipelineDefinition, PipelineEngineConfig, StageDefinition } from "./types.js";

let stateMachine: StateMachine;
let dispatcher: Dispatcher;
let router: Router;
let triggerMatcher: TriggerMatcher;
let pipelines: PipelineDefinition[] = [];

async function loadPipelines(ctx: PluginContext): Promise<PipelineDefinition[]> {
  const config = (await ctx.config.get()) as PipelineEngineConfig;
  const triggerLabels = config.trigger_labels ?? {};
  const loaded: PipelineDefinition[] = [];

  // Load pipeline definitions from plugin state (stored at install/config time)
  // For MVP, use hardcoded pipeline definitions from the trigger_labels config
  // Future: load from workspace files via ctx.workspace
  for (const [labelName, pipelineName] of Object.entries(triggerLabels)) {
    // Try to load from state
    const yamlContent = await ctx.state.get({ scopeKind: "instance", namespace: "pipeline", stateKey: `yaml:${pipelineName}` });
    if (yamlContent) {
      const pipeline = parsePipeline(yamlContent as string);
      const validation = validateDAG(pipeline);
      if (validation.valid) {
        loaded.push(pipeline);
      } else {
        ctx.logger.warn("Invalid pipeline definition", { pipelineName, errors: validation.errors });
      }
    }
  }

  return loaded;
}

async function handleIssueEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const issueId = event.entityId;
  if (!issueId) return;

  const issue = await ctx.issues.get(issueId, event.companyId);
  if (!issue) return;

  // Deduplication: skip if a pipeline is already running for this issue
  // (handles duplicate events from rapid label additions or issue.updated re-fires)
  const existingRun = await stateMachine.getActiveRunForIssue(issueId, event.companyId);
  if (existingRun) return;

  const issueLabelIds = issue.labelIds;
  if (!issueLabelIds || issueLabelIds.length === 0) return;

  // Look up label names from stored mapping (populated at config time)
  const labelNames = await resolveLabelNames(ctx, issueLabelIds, event.companyId);
  const matchedPipeline = triggerMatcher.match(labelNames);
  if (!matchedPipeline) return;

  await materializePipeline(ctx, matchedPipeline, issueId, event.companyId);
}

async function resolveLabelNames(ctx: PluginContext, labelIds: string[], companyId: string): Promise<string[]> {
  // Use cached label mapping from plugin state
  const mapping = await ctx.state.get({ scopeKind: "company", scopeId: companyId, stateKey: "label-name-map" });
  if (!mapping || typeof mapping !== "object") return [];
  const map = mapping as Record<string, string>;
  return labelIds.map((id) => map[id]).filter(Boolean);
}

async function materializePipeline(
  ctx: PluginContext,
  pipeline: PipelineDefinition,
  parentIssueId: string,
  companyId: string,
): Promise<void> {
  const runId = randomUUID();
  const pipelineYaml = JSON.stringify(pipeline); // Frozen at materialization

  await stateMachine.createRun({
    id: runId,
    companyId,
    parentIssueId,
    pipelineName: pipeline.name,
    pipelineVersion: 1,
    pipelineYaml,
  });

  // Create stage rows for all top-level stages
  for (const stage of pipeline.stages) {
    await stateMachine.createStage({
      id: randomUUID(),
      pipelineRunId: runId,
      stageId: stage.id,
    });
  }

  ctx.logger.info("Pipeline materialized", { runId, pipelineName: pipeline.name, parentIssueId });

  // Dispatch ready stages
  await advancePipeline(ctx, runId, pipeline, companyId);
}

async function advancePipeline(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  companyId: string,
): Promise<void> {
  const run = await stateMachine.getRun(runId);
  if (!run || run.status !== "running") return;

  const stageRows = await stateMachine.getRunStages(runId);

  // First, mark any stages whose skip_if evaluates to true
  const skippedStages = await router.getSkippedStages(pipeline, stageRows, companyId);
  for (const stageDef of skippedStages) {
    const stageRow = stageRows.find((s) => s.stageId === stageDef.id);
    if (!stageRow) continue;
    await stateMachine.updateStageStatus(stageRow.id, "skipped");
  }

  // Re-fetch if we skipped anything (downstream stages may now be unblocked)
  const currentRows = skippedStages.length > 0
    ? await stateMachine.getRunStages(runId)
    : stageRows;

  const readyStages = await router.getReadyStages(pipeline, currentRows, companyId);

  for (const stageDef of readyStages) {
    const stageRow = currentRows.find((s) => s.stageId === stageDef.id);
    if (!stageRow) continue;

    if (stageDef.type === "gate") {
      await handleGateStage(ctx, runId, pipeline, stageDef, stageRow, companyId);
      continue;
    }

    // Guard: only dispatch stages that require agent work
    if (!router.requiresAgentDispatch(stageDef)) {
      ctx.logger.warn("Stage type not dispatchable in this phase", { stageId: stageDef.id, type: stageDef.type });
      await stateMachine.updateStageStatus(stageRow.id, "failed");
      await stateMachine.setStageError(stageRow.id, `Stage type "${stageDef.type}" requires dynamic materialization (not yet supported)`);
      continue;
    }

    // Guard: stage must have an agent_role to be dispatched
    if (!stageDef.agent_role) {
      await stateMachine.updateStageStatus(stageRow.id, "failed");
      await stateMachine.setStageError(stageRow.id, `Stage "${stageDef.id}" has no agent_role configured`);
      continue;
    }

    // Dispatch agent work
    await stateMachine.updateStageStatus(stageRow.id, "running");
    const result = await dispatcher.dispatch({
      pipelineRunId: runId,
      stage: stageDef,
      companyId,
      parentIssueId: run.parentIssueId,
    });
    await stateMachine.setStageSubIssueId(stageRow.id, result.issueId);
  }

  // Check if pipeline is complete
  const updatedRows = await stateMachine.getRunStages(runId);
  const allDone = updatedRows.every((s) => s.status === "completed" || s.status === "skipped");
  if (allDone && updatedRows.length > 0) {
    await stateMachine.updateRunStatus(runId, "completed");
    ctx.logger.info("Pipeline completed", { runId });
  }
}

async function handleGateStage(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  stageDef: StageDefinition,
  stageRow: { id: string },
  companyId: string,
): Promise<void> {
  const stageRows = await stateMachine.getRunStages(runId);

  const context = buildExpressionContext(
    stageRows.map((s) => ({ stageId: s.stageId, status: s.status, output: s.output, retryCount: s.retryCount })),
    pipeline.name,
    1,
    "",
    companyId,
  );

  const conditionMet = stageDef.condition ? await evaluateCondition(stageDef.condition, context) : true;

  if (conditionMet) {
    await stateMachine.updateStageStatus(stageRow.id, "completed");
    await advancePipeline(ctx, runId, pipeline, companyId);
  } else {
    await stateMachine.updateStageStatus(stageRow.id, "failed");
    await handleStageFailure(ctx, runId, pipeline, stageDef, stageRow.id, companyId);
  }
}

async function handleCommentEvent(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const payload = event.payload as { issueId?: string; body?: string; commentId?: string };
  if (!payload.issueId || !payload.body) return;

  // Check if this comment is on a tracked sub-issue
  const stageRow = await stateMachine.getStageBySubIssueId(payload.issueId);
  if (!stageRow) return;

  // Try to extract structured output
  const output = extractOutput(payload.body);
  if (!output) return;

  // Load the pipeline definition from the run record
  const run = await stateMachine.getRun(stageRow.pipelineRunId);
  if (!run) return;

  const pipeline = JSON.parse(run.pipelineYaml) as PipelineDefinition;
  const stageDef = pipeline.stages.find((s) => s.id === stageRow.stageId);
  if (!stageDef) return;

  // Validate output against schema if specified
  if (stageDef.output_schema) {
    const schema = loadSchema(stageDef.output_schema);
    const validation = validateOutput(output, schema);
    if (!validation.valid) {
      await stateMachine.setStageError(stageRow.id, `malformed output: ${validation.error}`);
      await stateMachine.updateStageStatus(stageRow.id, "failed");
      await handleStageFailure(ctx, stageRow.pipelineRunId, pipeline, stageDef, stageRow.id, run.companyId);
      return;
    }
  }

  // Store output and mark complete
  await stateMachine.setStageOutput(stageRow.id, output);
  await stateMachine.updateStageStatus(stageRow.id, "completed");

  ctx.logger.info("Stage completed", { stageId: stageRow.stageId, pipelineRunId: stageRow.pipelineRunId });

  // If this is a checkpoint stage, handle dynamic downstream planning
  if (stageDef.checkpoint) {
    await handleCheckpointCompletion(ctx, stageRow.pipelineRunId, pipeline, stageDef, output, run.companyId);
    return;
  }

  // Advance pipeline
  await advancePipeline(ctx, stageRow.pipelineRunId, pipeline, run.companyId);
}

async function handleCheckpointCompletion(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  checkpointStageDef: StageDefinition,
  output: Record<string, unknown>,
  companyId: string,
): Promise<void> {
  // Checkpoint stages pause materialization so the engine can dynamically plan
  // downstream stages based on the checkpoint's output (e.g., decomposer produces
  // multiple tasks that each need their own sub-pipeline).
  //
  // For MVP: log that checkpoint completed and advance normally.
  // Sub-pipeline dynamic creation is deferred (see Implementation Notes).
  ctx.logger.info("Checkpoint stage completed — dynamic downstream planning", {
    runId,
    stageId: checkpointStageDef.id,
    outputKeys: Object.keys(output),
  });

  // Check if downstream stages are sub-pipelines — if so, they can't be dispatched yet
  const downstreamDefs = pipeline.stages.filter((s) =>
    (s.depends_on ?? []).includes(checkpointStageDef.id),
  );
  const hasSubPipelines = downstreamDefs.some((s) => s.type === "sub-pipeline");

  if (hasSubPipelines) {
    // Sub-pipeline materialization requires creating child pipeline runs
    // from the checkpoint output (e.g., one per task in decomposition-output).
    // This is deferred — mark pipeline as paused pending implementation.
    ctx.logger.warn("Sub-pipeline materialization not yet implemented — pipeline paused", { runId });
    await stateMachine.updateRunStatus(runId, "paused");
    return;
  }

  // If no sub-pipelines downstream, advance normally
  await advancePipeline(ctx, runId, pipeline, companyId);
}

async function handleStageFailure(
  ctx: PluginContext,
  runId: string,
  pipeline: PipelineDefinition,
  stageDef: StageDefinition,
  stageRowId: string,
  companyId: string,
): Promise<void> {
  const stageRows = await stateMachine.getRunStages(runId);
  const stageRow = stageRows.find((s) => s.id === stageRowId);
  if (!stageRow) return;

  // Find the target stage row for retry count check
  const targetStageId = stageDef.on_failure?.retry_with?.goto;
  const targetRow = targetStageId
    ? stageRows.find((s) => s.stageId === targetStageId)
    : undefined;

  // evaluateFailure checks the TARGET stage's retry count (not the failing stage's)
  const failureAction = router.evaluateFailure(stageDef, stageRow, targetRow ?? undefined);

  if (failureAction.action === "escalate") {
    await stateMachine.updateRunStatus(runId, "escalated");
    const run = await stateMachine.getRun(runId);
    if (run) {
      await ctx.issues.createComment(
        run.parentIssueId,
        `Pipeline escalated: stage "${stageDef.id}" failed after ${(targetRow ?? stageRow).retryCount} retries.`,
        companyId,
        {},
      );
    }
    ctx.logger.warn("Pipeline escalated", { runId, stageId: stageDef.id });
    return;
  }

  if (failureAction.action === "goto" && failureAction.targetStageId) {
    const gotoTargetRow = stageRows.find((s) => s.stageId === failureAction.targetStageId);
    if (!gotoTargetRow) return;

    const targetDef = pipeline.stages.find((s) => s.id === failureAction.targetStageId);
    if (!targetDef) return;

    // Increment retry count on the TARGET stage (not the failing stage)
    await stateMachine.incrementRetryCount(gotoTargetRow.id);

    // Reset all stages downstream of the goto target to pending
    const allStageIds = pipeline.stages.map((s) => s.id);
    const adjacency = new Map(pipeline.stages.map((s) => [s.id, s.depends_on ?? []]));
    await stateMachine.resetDownstreamStages(runId, failureAction.targetStageId, allStageIds, adjacency);

    // Dispatch the target stage with failure context
    const run = await stateMachine.getRun(runId);
    if (!run) return;

    await stateMachine.updateStageStatus(gotoTargetRow.id, "running");
    const result = await dispatcher.dispatch({
      pipelineRunId: runId,
      stage: targetDef,
      companyId,
      parentIssueId: run.parentIssueId,
      context: failureAction.body,
    });
    await stateMachine.setStageSubIssueId(gotoTargetRow.id, result.issueId);
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    const config = (await ctx.config.get()) as PipelineEngineConfig;

    stateMachine = new StateMachine(ctx.db as any);
    dispatcher = new Dispatcher(ctx.issues as any, config.role_mapping ?? {}, ctx.manifest.id);
    router = new Router();

    pipelines = await loadPipelines(ctx);
    triggerMatcher = new TriggerMatcher(pipelines);

    ctx.logger.info("Pipeline engine initialized", { pipelineCount: pipelines.length });

    ctx.events.on("issue.created", async (event: PluginEvent) => {
      await handleIssueEvent(ctx, event);
    });

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      await handleIssueEvent(ctx, event);
    });

    ctx.events.on("issue.comment.created", async (event: PluginEvent) => {
      await handleCommentEvent(ctx, event);
    });
  },

  async onConfigChanged(newConfig, ctx) {
    const config = newConfig as PipelineEngineConfig;
    dispatcher = new Dispatcher(ctx.issues as any, config.role_mapping ?? {}, ctx.manifest.id);
    pipelines = await loadPipelines(ctx);
    triggerMatcher = new TriggerMatcher(pipelines);
  },

  async onApiRequest(input) {
    if (input.routeKey === "run-status") {
      const runId = input.params?.runId;
      if (!runId) return { status: 400, body: { error: "runId required" } };
      const run = await stateMachine.getRun(runId);
      if (!run) return { status: 404, body: { error: "not found" } };
      const stages = await stateMachine.getRunStages(runId);
      return { status: 200, body: { run, stages } };
    }
    if (input.routeKey === "pipelines") {
      return { status: 200, body: { pipelines: pipelines.map((p) => ({ name: p.name, trigger: p.trigger, stageCount: p.stages.length })) } };
    }
    return { status: 404, body: { error: "unknown route" } };
  },
});

runWorker(plugin, import.meta.url);
```

- [ ] **Step 2: Verify typecheck**

Run: `cd packages/plugins/pipeline-engine && pnpm typecheck`
Expected: PASS (may need minor type adjustments)

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/pipeline-engine/src/worker.ts
git commit -m "feat(pipeline-engine): add main worker with event wiring"
```

---

### Task 15: Example Pipeline YAML Definitions

**Files:**
- Create: `packages/plugins/pipeline-engine/pipelines/feature.yaml`
- Create: `packages/plugins/pipeline-engine/pipelines/bug.yaml`
- Create: `packages/plugins/pipeline-engine/pipelines/fast-track.yaml`
- Create: `packages/plugins/pipeline-engine/pipelines/test-writing.yaml`
- Create: `packages/plugins/pipeline-engine/pipelines/implementation.yaml`

- [ ] **Step 1: Create pipeline YAML files**

Copy the YAML definitions from the spec (`docs/specs/2026-05-10-pipeline-engine-design.md` lines 128–306 and 653–678) into the corresponding files.

- [ ] **Step 2: Verify DAG parser can load them**

Write a quick integration test or script that loads each YAML and runs `validateDAG`. All should pass.

- [ ] **Step 3: Commit**

```bash
git add packages/plugins/pipeline-engine/pipelines/
git commit -m "feat(pipeline-engine): add example pipeline YAML definitions"
```

---

### Task 16: Integration Test & Build Verification

- [ ] **Step 1: Write end-to-end integration test**

**Files:**
- Create: `packages/plugins/pipeline-engine/src/tests/integration.test.ts`

This test wires all components together with mocked SDK clients and simulates a full pipeline run:

```typescript
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { parsePipeline, validateDAG } from "../dag-parser.js";
import { Dispatcher } from "../dispatcher.js";
import { extractOutput, validateOutput, loadSchema, setSchemasDir } from "../output-parser.js";
import { Router } from "../router.js";
import { StateMachine } from "../state-machine.js";
import { TriggerMatcher } from "../trigger-matcher.js";
import type { PipelineStage } from "../types.js";

const FEATURE_YAML = `
name: feature
description: Full feature development
trigger:
  label: "pipeline:feature"
stages:
  - id: spec-review
    type: classifier
    agent_role: spec-reviewer
    output_schema: spec-review-output
  - id: implement
    type: worker
    agent_role: code-writer
    depends_on: [spec-review]
    condition: "stages.\\"spec-review\\".output.status = 'approved'"
  - id: validate
    type: worker
    agent_role: validator
    depends_on: [implement]
    on_failure:
      retry_with:
        goto: implement
        body: "Fix: {{ output.errors }}"
        max_retries: 2
`;

function createMockDb() {
  const store = new Map<string, unknown[]>();
  return {
    namespace: "plugin_pipeline_engine_test",
    query: vi.fn().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("SELECT") && sql.includes("pipeline_stages")) {
        return store.get("stages") ?? [];
      }
      if (sql.includes("SELECT") && sql.includes("pipeline_runs")) {
        return store.get("runs") ?? [];
      }
      return [];
    }),
    execute: vi.fn().mockResolvedValue(undefined),
    _store: store,
  };
}

function createMockIssues() {
  let issueCounter = 0;
  return {
    create: vi.fn().mockImplementation(async () => ({ id: `issue-${++issueCounter}` })),
    requestWakeup: vi.fn().mockResolvedValue({ queued: true }),
    documents: { upsert: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("integration: end-to-end pipeline flow", () => {
  beforeAll(() => {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    setSchemasDir(resolve(__dirname, "../../schemas"));
  });

  it("triggers pipeline, dispatches stages, processes output, and advances", async () => {
    // 1. Parse and validate pipeline
    const pipeline = parsePipeline(FEATURE_YAML);
    const validation = validateDAG(pipeline);
    expect(validation.valid).toBe(true);

    // 2. Trigger matcher finds the pipeline
    const matcher = new TriggerMatcher([pipeline]);
    const matched = matcher.match(["pipeline:feature", "priority:high"]);
    expect(matched).not.toBeNull();
    expect(matched!.name).toBe("feature");

    // 3. Router identifies ready stages (spec-review has no deps)
    const router = new Router();
    const initialStages: PipelineStage[] = [
      { id: "row-1", pipelineRunId: "run-1", stageId: "spec-review", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
      { id: "row-2", pipelineRunId: "run-1", stageId: "implement", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
      { id: "row-3", pipelineRunId: "run-1", stageId: "validate", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
    ];

    const ready = await router.getReadyStages(pipeline, initialStages, "company-1");
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe("spec-review");

    // 4. Dispatcher creates sub-issue
    const issues = createMockIssues();
    const dispatcher = new Dispatcher(issues as any, { "spec-reviewer": "agent-1", "code-writer": "agent-2", "validator": "agent-3" }, "paperclipai.pipeline-engine");
    const dispatchResult = await dispatcher.dispatch({
      pipelineRunId: "run-1",
      stage: ready[0],
      companyId: "company-1",
      parentIssueId: "parent-1",
    });
    expect(dispatchResult.issueId).toBe("issue-1");

    // 5. Simulate agent completing with approved output
    const commentBody = `Done reviewing.\n\n<!-- pipeline-output -->\n\`\`\`json\n{"status": "approved", "completeness_score": 0.95}\n\`\`\``;
    const output = extractOutput(commentBody);
    expect(output).not.toBeNull();
    expect(output!.status).toBe("approved");

    // 6. Validate output against schema
    const schema = loadSchema("spec-review-output");
    const validated = validateOutput(output!, schema);
    expect(validated.valid).toBe(true);

    // 7. After spec-review completes, implement becomes ready
    const afterSpecReview: PipelineStage[] = [
      { ...initialStages[0], status: "completed", output: { status: "approved", completeness_score: 0.95 } },
      { ...initialStages[1] },
      { ...initialStages[2] },
    ];
    const nextReady = await router.getReadyStages(pipeline, afterSpecReview, "company-1");
    expect(nextReady).toHaveLength(1);
    expect(nextReady[0].id).toBe("implement");

    // 8. Simulate validate failure with retry — target (implement) has retries remaining
    const failedValidateStage = { ...initialStages[2], status: "failed" as const, output: { errors: ["test_a failed"] }, retryCount: 0 };
    const implementTargetRow = { ...initialStages[1], status: "completed" as const, retryCount: 0 };
    const failureAction = router.evaluateFailure(pipeline.stages[2], failedValidateStage, implementTargetRow);
    expect(failureAction.action).toBe("goto");
    expect(failureAction.targetStageId).toBe("implement");
    expect(failureAction.body).toContain("test_a failed");

    // 9. Simulate max retries exceeded on TARGET stage → escalate
    const maxRetriedTarget = { ...implementTargetRow, retryCount: 2 };
    const escalateAction = router.evaluateFailure(pipeline.stages[2], failedValidateStage, maxRetriedTarget);
    expect(escalateAction.action).toBe("escalate");
  });

  it("checkpoint with downstream sub-pipeline stages blocks advancement", async () => {
    const checkpointPipeline = parsePipeline(`
name: checkpoint-test
description: Test checkpoint pause behavior
trigger:
  label: "pipeline:checkpoint-test"
stages:
  - id: decompose
    type: classifier
    agent_role: decomposer
    output_schema: decomposition-output
    checkpoint: true
  - id: write-tests
    type: sub-pipeline
    pipeline: test-writing
    per_task: true
    depends_on: [decompose]
  - id: implement
    type: sub-pipeline
    pipeline: implementation
    per_task: true
    depends_on: [write-tests]
`);
    expect(validateDAG(checkpointPipeline).valid).toBe(true);

    const router = new Router();

    // After decompose completes, write-tests (sub-pipeline) should NOT be returned
    // by getReadyStages — sub-pipeline types are skipped by the router
    const stagesAfterCheckpoint: PipelineStage[] = [
      { id: "row-1", pipelineRunId: "run-2", stageId: "decompose", subIssueId: null, status: "completed", retryCount: 0, output: { tasks: [] }, error: null, startedAt: null, completedAt: null },
      { id: "row-2", pipelineRunId: "run-2", stageId: "write-tests", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
      { id: "row-3", pipelineRunId: "run-2", stageId: "implement", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
    ];

    const ready = await router.getReadyStages(checkpointPipeline, stagesAfterCheckpoint, "company-1");
    // No stages should be ready — write-tests is a sub-pipeline (skipped by router)
    // and implement depends on write-tests which is still pending
    expect(ready).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run full test suite**

Run: `cd packages/plugins/pipeline-engine && pnpm test`
Expected: All tests PASS

- [ ] **Step 3: Run typecheck**

Run: `cd packages/plugins/pipeline-engine && pnpm typecheck`
Expected: PASS

- [ ] **Step 4: Run build**

Run: `cd packages/plugins/pipeline-engine && pnpm build`
Expected: Build succeeds, `dist/` contains `manifest.js`, `worker.js`, and `schemas/`

- [ ] **Step 5: Fix any issues found in steps 2-4**

- [ ] **Step 6: Final commit**

```bash
git add -A packages/plugins/pipeline-engine/
git commit -m "feat(pipeline-engine): add integration test and finalize build"
```

---

## Integration Testing — Internal Developer Portal

The pipeline engine is validated against a real company: **Internal Developer Portal** (`dream-applied-ai/internal-developer-portal`). Real agents write real code, orchestrated by pipeline YAMLs.

### Test Target Structure

```
internal-developer-portal/
├── .paperclip/
│   ├── paperclip.yaml           # Company: 6 agents (spec-reviewer, decomposer, test-writer, implementer, validator, reviewer)
│   ├── pipelines/
│   │   ├── feature.yaml         # spec-review → decompose → write-tests → implement → validate → review → merge-gate
│   │   ├── bug.yaml             # write-tests → implement → validate → review
│   │   └── fast-track.yaml      # implement → validate
│   ├── governance/              # Engineering standards, factory rules (immutable)
│   └── scenarios/               # 19 holdout validation scenarios
├── services/
│   ├── backend/                 # FastAPI (Python 3.12+, uv, pytest)
│   └── frontend/               # Next.js 15 (React 19, TypeScript, Vitest)
└── docs/specs/
```

### How to Run

1. Start local Paperclip: `pnpm dev` (in paperclip repo)
2. Ensure pipeline-engine plugin is loaded (build + link or install to `~/.paperclip/plugins/`)
3. Open Internal Developer Portal workspace in UI
4. Create an issue describing a feature (e.g., scenario 001: shell layout navigation)
5. Add label `pipeline:feature`
6. Observe pipeline materialization and agent execution

### Test Scenarios

| # | Scenario | Pipeline | Validates |
|---|----------|----------|-----------|
| 1 | Shell layout + navigation (scenario 001) | `feature` | Full happy path: all 7 stages fire in sequence |
| 2 | Intentionally incomplete spec | `feature` | Spec-reviewer rejects → pipeline halts at stage 1 |
| 3 | Failing implementation (introduce type error) | `feature` | Validator fails → retry loop → implementer re-runs → pass |
| 4 | Max retries exhausted | `feature` | 3 retries fail → escalation comment, pipeline halted |
| 5 | Bug fix (e.g., broken health endpoint) | `bug` | Shorter pipeline skips spec-review/decompose |
| 6 | Typo fix | `fast-track` | Minimal 2-stage pipeline |

### Success Criteria

- [ ] Trigger matcher fires correctly on label addition
- [ ] Sub-issues created with correct agent assignments and structured context
- [ ] Agents produce valid structured JSON output (parseable by output-parser)
- [ ] Router evaluates conditions and advances to correct next stage
- [ ] Retry loop works: validator failure → goto implement → re-run
- [ ] Fan-in waits for all parallel tasks before advancing
- [ ] Pipeline run completes with all stages in `completed` status
- [ ] State machine transitions visible in debug API (`/api/plugins/pipeline-engine/run-status`)

---

## Implementation Notes

### What's Deferred

These items from the spec are intentionally not in this plan — they belong in follow-up work:

1. **Sub-pipeline creation from decomposer output** — The worker handles the basic flow but dynamic sub-pipeline creation from checkpoint outputs needs a dedicated follow-up task (complex fan-out materialization, worktree allocation, branch merge strategy). **Guard in place:** checkpoint stages pause the pipeline with status `paused` when downstream sub-pipelines are detected; sub-pipeline and parallel_fan_out stage types are skipped by the router with a clear error.

2. **Label name resolution** — The current implementation uses a stored label-name mapping in plugin state. A proper solution would use a labels API if one becomes available in the SDK, or a background sync job. The manifest declares `"labels"` in `coreReadTables` to enable direct DB queries as a fallback.

3. **Timeout handling** — Per-stage timeouts (spec: "default 30 min if omitted") require a scheduled job that periodically checks for timed-out stages. Add as a follow-up task.

4. **Manual intervention labels** (`pipeline:resume`, `pipeline:skip`, `pipeline:cancel`) — Requires label change detection in `issue.updated` events and matching against the parent issue's pipeline run. Straightforward but adds scope.

5. **Multi-tenant pipeline definition storage** — Per-company YAML storage and management UI. MVP stores pipelines in plugin state.

6. **Fan-out stages with nested `stages` array** — The router currently only handles top-level stages. Parallel fan-out with nested stage definitions needs recursive handling. **Guard in place:** `parallel_fan_out` stages are skipped by the router; `advancePipeline` logs a warning and fails the stage with a clear error message.

7. **Triage & automatic pipeline assignment** — The spec describes a Triage agent flow where unlabeled issues get classified and automatically routed to the correct pipeline track. This is a pre-pipeline feature not part of the core routing engine.

8. **Worktree isolation & branch merge strategy** — The spec details separate worktrees per sub-pipeline, a merge branch strategy (`pipeline/<run-id>/merged`), sequential dependency-ordered merging, and merge conflict detection with retry context. This is architecturally significant and requires workspace integration.

9. **Boundary enforcement** — The spec requires agents receive "bounded" tasks with information isolation (no access to other tasks' specs, parent pipeline state, or other agents' outputs) and skill removal. The dispatcher creates sub-issues but does not enforce input boundaries in this phase.

### Key Design Decisions Made During Planning

1. **Schema loading uses filesystem with configurable base dir** — Schemas are bundled with the plugin and copied to `dist/schemas/` by the esbuild config. The `output-parser.ts` resolves them relative to `import.meta.url` at runtime, but exposes `setSchemasDir()` for tests to override the path.

2. **Pipeline YAML frozen as JSON** — At materialization time, the pipeline definition is serialized as JSON (not YAML) into the DB. This is simpler than re-parsing YAML on every advance.

3. **Label resolution via plugin state** — Since the SDK doesn't expose a `listLabels()` method, label name→ID mapping is stored in plugin state (populated during configuration or via a sync job).

4. **Gate stages are synchronous** — They evaluate immediately during pipeline advancement, no async agent dispatch needed.

5. **Event deduplication via active-run check** — `handleIssueEvent` checks for an existing active run before materializing, which prevents duplicate pipelines from rapid re-fires of `issue.updated`.

6. **Debug API routes** — `onApiRequest` exposes `run-status` and `pipelines` endpoints for development-time inspection of pipeline state.

7. **`skip_if` supported** — The router evaluates `skip_if` expressions and marks stages as `skipped`, allowing downstream stages to proceed.

8. **Retry counter on target stage** — When a failure triggers a `goto`, the retry count is tracked on the **target** stage (the one being retried), not the stage that detected the failure. This ensures max_retries accurately reflects how many times the target has been re-attempted.

9. **Downstream reset on goto** — When a `goto` fires, all stages downstream of the target are reset to `pending`. This ensures the pipeline re-executes the full path from the retry point, not just the target stage.

10. **Safe guards for unimplemented stage types** — `sub-pipeline` and `parallel_fan_out` stages are explicitly skipped by the router. If they somehow reach `advancePipeline`, a guard fails them with a descriptive error rather than silently passing or crashing. Checkpoint stages pause the pipeline when sub-pipeline downstream is detected.

11. **SDK method signatures** — The escalation handler calls `ctx.issues.createComment(issueId, body, companyId, {})`. Verify the actual plugin SDK method signature at implementation time (check `packages/plugin-sdk/` for the `IssuesClient` interface) and adjust parameters accordingly.
