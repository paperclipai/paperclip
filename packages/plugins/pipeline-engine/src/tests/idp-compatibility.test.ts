import { describe, it, expect } from "vitest";
import { parsePipeline, validateDAG } from "../dag-parser.js";
import { evaluateCondition, buildExpressionContext } from "../expression-engine.js";
import { Router } from "../router.js";
import type { PipelineDefinition, PipelineStage, StageStatus } from "../types.js";

const FEATURE_JSON: PipelineDefinition = {
  name: "feature",
  description: "Full feature development pipeline",
  trigger: { label: "pipeline:feature" },
  stages: [
    { id: "spec-review", type: "classifier", agent_role: "spec-reviewer", output_schema: "spec-review-output", timeout: "2m" },
    { id: "decompose", type: "classifier", agent_role: "decomposer", output_schema: "decomposition-output", checkpoint: true, timeout: "3m" },
    { id: "write-tests", type: "worker", agent_role: "test-writer", per_task: true, ordering: "from_output", output_schema: "test-writing-output", timeout: "5m" },
    { id: "implement", type: "worker", agent_role: "implementer", per_task: true, ordering: "from_output", output_schema: "implementation-output", timeout: "10m", retry: { max_retries: 3, body: "Fix validation failures: {{ output.errors }}" } },
    { id: "validate", type: "worker", agent_role: "validator", fan_in: "all_complete", output_schema: "validation-output", timeout: "2m" },
    { id: "review", type: "parallel_fan_out", agent_role: "reviewer", timeout: "3m", fan_in: "all_complete" },
    { id: "merge-gate", type: "gate" },
  ],
  edges: [
    { id: "e1", from: "spec-review", to: "decompose", when: "output.status = 'approved'" },
    { id: "e2", from: "decompose", to: "write-tests" },
    { id: "e3", from: "write-tests", to: "implement" },
    { id: "e4", from: "implement", to: "validate" },
    { id: "e5", from: "validate", to: "review", when: "output.status = 'pass'" },
    { id: "e6", from: "validate", to: "implement", type: "error" },
    { id: "e7", from: "review", to: "merge-gate" },
  ],
  positions: {},
};

const BUG_JSON: PipelineDefinition = {
  name: "bug",
  description: "Bug fix pipeline",
  trigger: { label: "pipeline:bug" },
  stages: [
    { id: "write-tests", type: "worker", agent_role: "test-writer", output_schema: "test-writing-output", timeout: "5m" },
    { id: "implement", type: "worker", agent_role: "implementer", output_schema: "implementation-output", timeout: "10m", retry: { max_retries: 2, body: "Fix validation failures: {{ output.errors }}" } },
    { id: "validate", type: "worker", agent_role: "validator", output_schema: "validation-output", timeout: "2m" },
    { id: "review", type: "classifier", agent_role: "reviewer", output_schema: "review-output", timeout: "3m" },
  ],
  edges: [
    { id: "e1", from: "write-tests", to: "implement" },
    { id: "e2", from: "implement", to: "validate" },
    { id: "e3", from: "validate", to: "review", when: "output.status = 'pass'" },
    { id: "e4", from: "validate", to: "implement", type: "error" },
  ],
  positions: {},
};

const FAST_TRACK_JSON: PipelineDefinition = {
  name: "fast-track",
  description: "Fast-track pipeline for trivial changes",
  trigger: { label: "pipeline:fast-track" },
  stages: [
    { id: "implement", type: "worker", agent_role: "implementer", output_schema: "implementation-output", timeout: "5m" },
    { id: "validate", type: "worker", agent_role: "validator", output_schema: "validation-output", timeout: "2m" },
  ],
  edges: [
    { id: "e1", from: "implement", to: "validate" },
  ],
  positions: {},
};

function loadPipelineJson(name: string): string {
  const map: Record<string, PipelineDefinition> = { feature: FEATURE_JSON, bug: BUG_JSON, "fast-track": FAST_TRACK_JSON };
  return JSON.stringify(map[name]!);
}

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

describe("IDP pipeline compatibility", () => {
  describe("parsing and DAG validation", () => {
    it("parses feature pipeline", () => {
      const pipeline = parsePipeline(loadPipelineJson("feature"));
      expect(pipeline.name).toBe("feature");
      expect(pipeline.trigger.label).toBe("pipeline:feature");
      expect(pipeline.stages).toHaveLength(7);
    });

    it("validates feature pipeline DAG", () => {
      const pipeline = parsePipeline(loadPipelineJson("feature"));
      const result = validateDAG(pipeline);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("parses bug pipeline", () => {
      const pipeline = parsePipeline(loadPipelineJson("bug"));
      expect(pipeline.name).toBe("bug");
      expect(pipeline.stages).toHaveLength(4);
    });

    it("validates bug pipeline DAG", () => {
      const pipeline = parsePipeline(loadPipelineJson("bug"));
      expect(validateDAG(pipeline).valid).toBe(true);
    });

    it("parses fast-track pipeline", () => {
      const pipeline = parsePipeline(loadPipelineJson("fast-track"));
      expect(pipeline.name).toBe("fast-track");
      expect(pipeline.stages).toHaveLength(2);
    });

    it("validates fast-track pipeline DAG", () => {
      const pipeline = parsePipeline(loadPipelineJson("fast-track"));
      expect(validateDAG(pipeline).valid).toBe(true);
    });
  });

  describe("expression evaluation with IDP syntax", () => {
    it("evaluates == operator (normalized to =)", async () => {
      const ctx = buildExpressionContext(
        [{ stageId: "spec-review", status: "completed", output: { status: "approved" }, retryCount: 0 }],
        "feature", 1, "", "co-1",
      );
      const result = await evaluateCondition("stages.spec_review.output.status == 'approved'", ctx);
      expect(result).toBe(true);
    });

    it("resolves underscore-normalized stage keys", async () => {
      const ctx = buildExpressionContext(
        [{ stageId: "spec-review", status: "completed", output: { status: "approved" }, retryCount: 0 }],
        "feature", 1, "", "co-1",
      );
      const result = await evaluateCondition("stages.spec_review.output.status = 'approved'", ctx);
      expect(result).toBe(true);
    });

    it("still works with quoted hyphenated keys", async () => {
      const ctx = buildExpressionContext(
        [{ stageId: "spec-review", status: "completed", output: { status: "approved" }, retryCount: 0 }],
        "feature", 1, "", "co-1",
      );
      const result = await evaluateCondition('stages."spec-review".output.status = \'approved\'', ctx);
      expect(result).toBe(true);
    });

    it("evaluates .every() pattern (normalized to $count filter)", async () => {
      const ctx = buildExpressionContext(
        [{ stageId: "review", status: "completed", output: { every_result: true }, retryCount: 0 }],
        "feature", 1, "", "co-1",
      );
      const reviewOutput = [
        { decision: "approve" },
        { decision: "approve" },
      ];
      const ctxWithArray = {
        ...ctx,
        stages: { ...ctx.stages, review: { ...ctx.stages.review, output: reviewOutput } },
      };
      const result = await evaluateCondition(
        "stages.review.output.every(r => r.decision == 'approve')",
        ctxWithArray,
      );
      expect(result).toBe(true);
    });

    it(".every() returns false when one item doesn't match", async () => {
      const reviewOutput = [
        { decision: "approve" },
        { decision: "request-changes" },
      ];
      const ctx = {
        stages: { review: { output: reviewOutput, status: "completed" as StageStatus, retry_count: 0 } },
        pipeline: { name: "feature", version: 1, parent_issue_id: "" },
        env: { company_id: "co-1" },
      };
      const result = await evaluateCondition(
        "stages.review.output.every(r => r.decision == 'approve')",
        ctx,
      );
      expect(result).toBe(false);
    });
  });

  describe("router handles parallel_fan_out stages", () => {
    it("marks parallel_fan_out as requiring agent dispatch", () => {
      const router = new Router();
      expect(router.requiresAgentDispatch({ id: "review", type: "parallel_fan_out", agent_role: "reviewer" })).toBe(true);
    });

    it("includes parallel_fan_out in ready stages when deps met", async () => {
      const pipeline = parsePipeline(loadPipelineJson("feature"));
      const router = new Router();

      const stages = pipeline.stages.map((s) => {
        if (s.id === "review") return makeStage(s.id, "pending");
        return makeStage(s.id, "completed", s.id === "validate" ? { status: "pass" } : {});
      });

      const ready = await router.getReadyStages(pipeline, stages, "co-1");
      expect(ready.map((s) => s.id)).toContain("review");
    });
  });

  describe("router handles checkpoint stages", () => {
    it("blocks downstream when checkpoint not yet completed", async () => {
      const pipeline = parsePipeline(loadPipelineJson("feature"));
      const router = new Router();

      const stages = [
        makeStage("spec-review", "completed", { status: "approved" }),
        makeStage("decompose", "running"),
        makeStage("write-tests", "pending"),
      ];
      const ready = await router.getReadyStages(pipeline, stages, "co-1");
      expect(ready.map((s) => s.id)).not.toContain("write-tests");
    });

    it("allows downstream after checkpoint completed", async () => {
      const pipeline = parsePipeline(loadPipelineJson("feature"));
      const router = new Router();

      const stages = [
        makeStage("spec-review", "completed", { status: "approved" }),
        makeStage("decompose", "completed", { tasks: ["t1", "t2"] }),
        makeStage("write-tests", "pending"),
      ];
      const ready = await router.getReadyStages(pipeline, stages, "co-1");
      expect(ready.map((s) => s.id)).toContain("write-tests");
    });
  });

  describe("router handles fast-track pipeline end-to-end", () => {
    it("advances through fast-track correctly", async () => {
      const pipeline = parsePipeline(loadPipelineJson("fast-track"));
      const router = new Router();

      const initial = pipeline.stages.map((s) => makeStage(s.id, "pending"));
      const ready1 = await router.getReadyStages(pipeline, initial, "co-1");
      expect(ready1.map((s) => s.id)).toEqual(["implement"]);

      const afterImpl = [
        makeStage("implement", "completed", { status: "done" }),
        makeStage("validate", "pending"),
      ];
      const ready2 = await router.getReadyStages(pipeline, afterImpl, "co-1");
      expect(ready2.map((s) => s.id)).toEqual(["validate"]);
    });
  });
});
