import { describe, it, expect } from "vitest";
import { Router } from "../router.js";
import { validateDAG } from "../dag-parser.js";
import { StateMachine } from "../state-machine.js";
import type { PipelineDefinition, PipelineStage, StageStatus } from "../types.js";

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

const loopPipeline: PipelineDefinition = {
  name: "loop-test",
  description: "",
  trigger: { label: "pipeline:loop" },
  stages: [
    { id: "write-tests", type: "stage", agent_role: "test-writer" },
    { id: "review", type: "stage", agent_role: "reviewer" },
    { id: "escalate", type: "stage", agent_role: "lead" },
  ],
  edges: [
    { id: "e1", from: "write-tests", to: "review" },
    { id: "e-loop", from: "review", to: "write-tests", type: "loop", max_iterations: 3 },
    { id: "e2", from: "review", to: "escalate", sourceHandle: "pass" },
  ],
  positions: {},
};

describe("loop edges", () => {
  const router = new Router();

  describe("DAG validation", () => {
    it("allows loop edges without triggering cycle detection", () => {
      const result = validateDAG(loopPipeline);
      expect(result.valid).toBe(true);
    });

    it("rejects loop edges with max_iterations <= 0", () => {
      const badPipeline: PipelineDefinition = {
        ...loopPipeline,
        edges: [
          ...loopPipeline.edges.filter((e) => e.id !== "e-loop"),
          { id: "e-loop", from: "review", to: "write-tests", type: "loop", max_iterations: 0 },
        ],
      };
      const result = validateDAG(badPipeline);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("max_iterations");
    });

    it("rejects loop edges with no max_iterations", () => {
      const badPipeline: PipelineDefinition = {
        ...loopPipeline,
        edges: [
          ...loopPipeline.edges.filter((e) => e.id !== "e-loop"),
          { id: "e-loop", from: "review", to: "write-tests", type: "loop" },
        ],
      };
      const result = validateDAG(badPipeline);
      expect(result.valid).toBe(false);
    });
  });

  describe("router with loop edges", () => {
    it("loop edge makes target ready when source completed and iterations remain", async () => {
      const stages = [
        makeStage("write-tests", "pending"),
        makeStage("review", "completed", { decision: "fail" }),
        makeStage("escalate", "pending"),
      ];
      const ready = await router.getReadyStages(loopPipeline, stages, "co-1", { "e-loop": 0 });
      expect(ready.map((s) => s.id)).toContain("write-tests");
    });

    it("loop edge does NOT make target ready when max_iterations exhausted", async () => {
      const stages = [
        makeStage("write-tests", "pending"),
        makeStage("review", "completed", { decision: "fail" }),
        makeStage("escalate", "pending"),
      ];
      const ready = await router.getReadyStages(loopPipeline, stages, "co-1", { "e-loop": 3 });
      expect(ready.map((s) => s.id)).not.toContain("write-tests");
    });

    it("getLoopEdgesForReadyStage identifies firing loop edges", () => {
      const stages = [
        makeStage("write-tests", "pending"),
        makeStage("review", "completed", { decision: "fail" }),
      ];
      const loopEdges = router.getLoopEdgesForReadyStage(
        "write-tests", loopPipeline, stages, { "e-loop": 1 },
      );
      expect(loopEdges).toHaveLength(1);
      expect(loopEdges[0].id).toBe("e-loop");
    });

    it("getLoopEdgesForReadyStage returns empty when exhausted", () => {
      const stages = [
        makeStage("write-tests", "pending"),
        makeStage("review", "completed", { decision: "fail" }),
      ];
      const loopEdges = router.getLoopEdgesForReadyStage(
        "write-tests", loopPipeline, stages, { "e-loop": 3 },
      );
      expect(loopEdges).toHaveLength(0);
    });
  });

  describe("state machine loop edge counts", () => {
    const mockDb = {
      namespace: "test",
      query: async () => [],
      execute: async () => ({ rowCount: 1 }),
    };

    it("tracks loop edge counts per run", () => {
      const sm = new StateMachine(mockDb as any);
      expect(sm.getLoopEdgeCounts("run-1")).toEqual({});
      sm.incrementLoopEdgeCount("run-1", "e-loop");
      expect(sm.getLoopEdgeCounts("run-1")).toEqual({ "e-loop": 1 });
      sm.incrementLoopEdgeCount("run-1", "e-loop");
      expect(sm.getLoopEdgeCounts("run-1")).toEqual({ "e-loop": 2 });
    });

    it("keeps counts isolated between runs", () => {
      const sm = new StateMachine(mockDb as any);
      sm.incrementLoopEdgeCount("run-a", "e1");
      sm.incrementLoopEdgeCount("run-b", "e1");
      sm.incrementLoopEdgeCount("run-b", "e1");
      expect(sm.getLoopEdgeCounts("run-a")).toEqual({ "e1": 1 });
      expect(sm.getLoopEdgeCounts("run-b")).toEqual({ "e1": 2 });
    });
  });
});
