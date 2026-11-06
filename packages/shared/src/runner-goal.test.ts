import { describe, expect, it } from "vitest";
import { RUNNER_GOAL_MAX_OBJECTIVE_CHARS, runnerGoalActionRequestSchema } from "./runner-goal.js";

describe("runner goal objective", () => {
  const request = (objective: string) => ({
    requestId: "request-1",
    agentId: "4f0b2c1e-8a57-4c7d-9e21-3d6f5a1b7c90",
    expectedRevision: 0,
    action: "create",
    objective,
  });

  it("bounds the objective by the string length the goal readers enforce", () => {
    const emoji = "😀".repeat(RUNNER_GOAL_MAX_OBJECTIVE_CHARS / 2);
    expect(runnerGoalActionRequestSchema.safeParse(request(emoji)).success).toBe(true);
    expect(runnerGoalActionRequestSchema.safeParse(request(`${emoji}x`)).success).toBe(false);
  });

  it("measures the objective after trimming", () => {
    const objective = "x".repeat(RUNNER_GOAL_MAX_OBJECTIVE_CHARS);
    expect(runnerGoalActionRequestSchema.safeParse(request(`  ${objective}  `)).success).toBe(true);
  });
});
