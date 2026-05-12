import { describe, it, expect } from "vitest";
import { Router } from "../router.js";
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

const fanOutPipeline: PipelineDefinition = {
  name: "conditional-fanout",
  description: "",
  trigger: { label: "pipeline:fanout" },
  stages: [
    { id: "plan", type: "stage", agent_role: "planner" },
    { id: "backend", type: "stage", agent_role: "backend-dev" },
    { id: "frontend", type: "stage", agent_role: "frontend-dev" },
    { id: "infra", type: "stage", agent_role: "infra-eng" },
    { id: "merge", type: "fan_in", fan_in_strategy: "all_complete" },
  ],
  edges: [
    { id: "e1", from: "plan", to: "backend", activationKey: "backend" },
    { id: "e2", from: "plan", to: "frontend", activationKey: "frontend" },
    { id: "e3", from: "plan", to: "infra", activationKey: "infra" },
    { id: "e4", from: "backend", to: "merge" },
    { id: "e5", from: "frontend", to: "merge" },
    { id: "e6", from: "infra", to: "merge" },
  ],
  positions: {},
};

describe("conditional fan-out (activationKey)", () => {
  const router = new Router();

  it("activates branches whose activationKey is in the tracks array", async () => {
    const stages = [
      makeStage("plan", "completed", { tracks: ["backend", "frontend"] }),
      makeStage("backend", "pending"),
      makeStage("frontend", "pending"),
      makeStage("infra", "pending"),
      makeStage("merge", "pending"),
    ];
    const ready = await router.getReadyStages(fanOutPipeline, stages, "co-1");
    const readyIds = ready.map((s) => s.id);
    expect(readyIds).toContain("backend");
    expect(readyIds).toContain("frontend");
    expect(readyIds).not.toContain("infra");
  });

  it("skips branches whose activationKey is NOT in the tracks array", async () => {
    const stages = [
      makeStage("plan", "completed", { tracks: ["backend"] }),
      makeStage("backend", "pending"),
      makeStage("frontend", "pending"),
      makeStage("infra", "pending"),
      makeStage("merge", "pending"),
    ];
    const skipped = await router.getSkippedStages(fanOutPipeline, stages, "co-1");
    const skippedIds = skipped.map((s) => s.id);
    expect(skippedIds).toContain("frontend");
    expect(skippedIds).toContain("infra");
    expect(skippedIds).not.toContain("backend");
  });

  it("fan-in waits for active branches only (skipped counts as resolved)", async () => {
    const stages = [
      makeStage("plan", "completed", { tracks: ["backend"] }),
      makeStage("backend", "completed"),
      makeStage("frontend", "skipped"),
      makeStage("infra", "skipped"),
      makeStage("merge", "pending"),
    ];
    const ready = await router.getReadyStages(fanOutPipeline, stages, "co-1");
    expect(ready.map((s) => s.id)).toContain("merge");
  });

  it("fan-in does NOT activate while active branches are still running", async () => {
    const stages = [
      makeStage("plan", "completed", { tracks: ["backend", "frontend"] }),
      makeStage("backend", "completed"),
      makeStage("frontend", "running"),
      makeStage("infra", "skipped"),
      makeStage("merge", "pending"),
    ];
    const ready = await router.getReadyStages(fanOutPipeline, stages, "co-1");
    expect(ready.map((s) => s.id)).not.toContain("merge");
  });

  it("activates all branches when tracks contains all keys", async () => {
    const stages = [
      makeStage("plan", "completed", { tracks: ["backend", "frontend", "infra"] }),
      makeStage("backend", "pending"),
      makeStage("frontend", "pending"),
      makeStage("infra", "pending"),
      makeStage("merge", "pending"),
    ];
    const ready = await router.getReadyStages(fanOutPipeline, stages, "co-1");
    const readyIds = ready.map((s) => s.id);
    expect(readyIds).toContain("backend");
    expect(readyIds).toContain("frontend");
    expect(readyIds).toContain("infra");
  });

  it("skips all branches when tracks is empty", async () => {
    const stages = [
      makeStage("plan", "completed", { tracks: [] }),
      makeStage("backend", "pending"),
      makeStage("frontend", "pending"),
      makeStage("infra", "pending"),
      makeStage("merge", "pending"),
    ];
    const skipped = await router.getSkippedStages(fanOutPipeline, stages, "co-1");
    const skippedIds = skipped.map((s) => s.id);
    expect(skippedIds).toContain("backend");
    expect(skippedIds).toContain("frontend");
    expect(skippedIds).toContain("infra");
  });
});
