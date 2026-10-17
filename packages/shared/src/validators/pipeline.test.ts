import { describe, expect, it } from "vitest";
import { pipelineStageAutomationSchema, pipelineStageOnEnterSchema } from "./pipeline.js";

describe("pipeline stage executionWorkspaceScope", () => {
  const routineId = "00000000-0000-4000-8000-000000000001";

  it("accepts the case scope and an absent or null scope", () => {
    expect(pipelineStageAutomationSchema.parse({ executionWorkspaceScope: "case" }).executionWorkspaceScope).toBe("case");
    expect(pipelineStageAutomationSchema.parse({}).executionWorkspaceScope).toBeUndefined();
    expect(pipelineStageOnEnterSchema.parse({ type: "run_routine", routineId, executionWorkspaceScope: null }).executionWorkspaceScope)
      .toBeNull();
  });

  it("rejects an unknown scope", () => {
    expect(pipelineStageAutomationSchema.safeParse({ executionWorkspaceScope: "pipeline" }).success).toBe(false);
    expect(pipelineStageOnEnterSchema.safeParse({ type: "run_routine", routineId, executionWorkspaceScope: "stage" }).success)
      .toBe(false);
  });
});
