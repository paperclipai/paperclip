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
