import { describe, it, expect } from "vitest";
import { Router } from "../router.js";
import type { PipelineDefinition, PipelineStage, StageStatus } from "../types.js";

function makeStage(stageId: string, status: StageStatus, output?: Record<string, unknown>, retryCount = 0): PipelineStage {
  return {
    id: `row-${stageId}`,
    pipelineRunId: "run-1",
    stageId,
    subIssueId: null,
    status,
    retryCount,
    output: output ?? null,
    error: null,
    startedAt: null,
    completedAt: null,
  };
}

const featurePipeline: PipelineDefinition = {
  name: "feature",
  description: "",
  trigger: { label: "pipeline:feature" },
  stages: [
    { id: "spec-review", type: "classifier", agent_role: "spec-reviewer" },
    { id: "decompose", type: "classifier", agent_role: "decomposer" },
    // implement has retry config because the error edge from validate points here
    { id: "implement", type: "worker", agent_role: "code-writer", retry: { max_retries: 3 } },
    { id: "validate", type: "worker", agent_role: "validator" },
  ],
  edges: [
    { id: "e1", from: "spec-review", to: "decompose", when: "output.status = 'approved'" },
    { id: "e2", from: "decompose", to: "implement" },
    { id: "e3", from: "implement", to: "validate" },
    { id: "e4", from: "validate", to: "implement", type: "error" },
  ],
  positions: {},
};

describe("router (edge-based)", () => {
  const router = new Router();

  describe("getReadyStages", () => {
    it("returns root stages when nothing has run", async () => {
      const stages = [makeStage("spec-review", "pending")];
      const ready = await router.getReadyStages(featurePipeline, stages, "company-1");
      expect(ready.map((s) => s.id)).toContain("spec-review");
    });

    it("returns next stage when edge source is completed and no condition", async () => {
      const stages = [
        makeStage("spec-review", "completed", { status: "approved" }),
        makeStage("decompose", "completed"),
        makeStage("implement", "pending"),
        makeStage("validate", "pending"),
      ];
      const ready = await router.getReadyStages(featurePipeline, stages, "company-1");
      expect(ready.map((s) => s.id)).toContain("implement");
    });

    it("does not return stage when conditional edge evaluates false", async () => {
      const stages = [
        makeStage("spec-review", "completed", { status: "rejected" }),
        makeStage("decompose", "pending"),
      ];
      const ready = await router.getReadyStages(featurePipeline, stages, "company-1");
      expect(ready.map((s) => s.id)).not.toContain("decompose");
    });

    it("returns stage when conditional edge evaluates true", async () => {
      const stages = [
        makeStage("spec-review", "completed", { status: "approved" }),
        makeStage("decompose", "pending"),
      ];
      const ready = await router.getReadyStages(featurePipeline, stages, "company-1");
      expect(ready.map((s) => s.id)).toContain("decompose");
    });

    it("does not return already-running stages", async () => {
      const stages = [makeStage("spec-review", "running")];
      const ready = await router.getReadyStages(featurePipeline, stages, "company-1");
      expect(ready).toHaveLength(0);
    });

    it("does not return sub-pipeline stages", async () => {
      const pipelineWithSubPipeline: PipelineDefinition = {
        ...featurePipeline,
        stages: [
          { id: "start", type: "worker", agent_role: "worker" },
          { id: "sub", type: "sub-pipeline", pipeline: "other" },
        ],
        edges: [{ id: "e1", from: "start", to: "sub" }],
      };
      const stages = [
        makeStage("start", "completed"),
        makeStage("sub", "pending"),
      ];
      const ready = await router.getReadyStages(pipelineWithSubPipeline, stages, "company-1");
      expect(ready.map((s) => s.id)).not.toContain("sub");
    });

    it("handles fan_in=first_complete: ready when any source completes", async () => {
      const fanPipeline: PipelineDefinition = {
        name: "fan",
        description: "",
        trigger: { label: "fan" },
        stages: [
          { id: "a", type: "worker", agent_role: "r" },
          { id: "b", type: "worker", agent_role: "r" },
          { id: "join", type: "worker", agent_role: "r", fan_in: "first_complete" },
        ],
        edges: [
          { id: "e1", from: "a", to: "join" },
          { id: "e2", from: "b", to: "join" },
        ],
        positions: {},
      };
      const stages = [
        makeStage("a", "completed"),
        makeStage("b", "pending"),
        makeStage("join", "pending"),
      ];
      const ready = await router.getReadyStages(fanPipeline, stages, "company-1");
      expect(ready.map((s) => s.id)).toContain("join");
    });

    it("handles all_complete fan_in: waits for all sources", async () => {
      const fanPipeline: PipelineDefinition = {
        name: "fan",
        description: "",
        trigger: { label: "fan" },
        stages: [
          { id: "a", type: "worker", agent_role: "r" },
          { id: "b", type: "worker", agent_role: "r" },
          { id: "join", type: "worker", agent_role: "r", fan_in: "all_complete" },
        ],
        edges: [
          { id: "e1", from: "a", to: "join" },
          { id: "e2", from: "b", to: "join" },
        ],
        positions: {},
      };
      const stages = [
        makeStage("a", "completed"),
        makeStage("b", "pending"),
        makeStage("join", "pending"),
      ];
      const ready = await router.getReadyStages(fanPipeline, stages, "company-1");
      expect(ready.map((s) => s.id)).not.toContain("join");
    });
  });

  describe("getSkippedStages", () => {
    it("marks stage as skipped when all conditional edges evaluate false", async () => {
      const stages = [
        makeStage("spec-review", "completed", { status: "rejected" }),
        makeStage("decompose", "pending"),
      ];
      const skipped = await router.getSkippedStages(featurePipeline, stages, "company-1");
      expect(skipped.map((s) => s.id)).toContain("decompose");
    });

    it("does not skip stage when conditional edge evaluates true", async () => {
      const stages = [
        makeStage("spec-review", "completed", { status: "approved" }),
        makeStage("decompose", "pending"),
      ];
      const skipped = await router.getSkippedStages(featurePipeline, stages, "company-1");
      expect(skipped.map((s) => s.id)).not.toContain("decompose");
    });

    it("does not skip root stages", async () => {
      const stages = [makeStage("spec-review", "pending")];
      const skipped = await router.getSkippedStages(featurePipeline, stages, "company-1");
      expect(skipped).toHaveLength(0);
    });
  });

  describe("evaluateFailure", () => {
    it("returns goto action when error edge exists and retry count below max", () => {
      const stageRow = makeStage("validate", "failed", { errors: ["test failed"] }, 0);
      const targetRow = makeStage("implement", "completed", undefined, 0);
      const result = router.evaluateFailure(featurePipeline, "validate", stageRow, targetRow);
      expect(result.action).toBe("goto");
      if (result.action === "goto") {
        expect(result.targetStageId).toBe("implement");
      }
    });

    it("returns escalate when retry count equals max_retries", () => {
      const stageRow = makeStage("validate", "failed", { errors: [] }, 0);
      const targetRow = makeStage("implement", "completed", undefined, 3);
      const result = router.evaluateFailure(featurePipeline, "validate", stageRow, targetRow);
      expect(result.action).toBe("escalate");
    });

    it("returns escalate when no error edges exist for the failed stage", () => {
      const stageRow = makeStage("spec-review", "failed", undefined, 0);
      const result = router.evaluateFailure(featurePipeline, "spec-review", stageRow);
      expect(result.action).toBe("escalate");
    });

    it("falls back to stageRow retry count when no targetStageRow provided", () => {
      const stageRow = makeStage("validate", "failed", undefined, 3);
      const result = router.evaluateFailure(featurePipeline, "validate", stageRow);
      expect(result.action).toBe("escalate");
    });
  });

  describe("requiresAgentDispatch", () => {
    it("returns true for worker stages", () => {
      const stage = featurePipeline.stages.find((s) => s.type === "worker")!;
      expect(router.requiresAgentDispatch(stage)).toBe(true);
    });

    it("returns true for classifier stages", () => {
      const stage = featurePipeline.stages.find((s) => s.type === "classifier")!;
      expect(router.requiresAgentDispatch(stage)).toBe(true);
    });

    it("returns true for parallel_fan_out stages", () => {
      const stage = { id: "fan", type: "parallel_fan_out" as const };
      expect(router.requiresAgentDispatch(stage)).toBe(true);
    });

    it("returns false for gate stages", () => {
      const stage = { id: "gate1", type: "gate" as const };
      expect(router.requiresAgentDispatch(stage)).toBe(false);
    });

    it("returns false for sub-pipeline stages", () => {
      const stage = { id: "sub", type: "sub-pipeline" as const, pipeline: "other" };
      expect(router.requiresAgentDispatch(stage)).toBe(false);
    });
  });
});
