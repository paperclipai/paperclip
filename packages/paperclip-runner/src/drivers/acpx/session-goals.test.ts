import { describe, expect, it } from "vitest";
import { acpxGoalProjection } from "./session-goals.js";
import type { AcpxRuntimeGoalCapability } from "./runtime-host.js";

describe("negotiated ACP goal projection", () => {
  const capability: AcpxRuntimeGoalCapability = {
    version: 1, controlMethod: "_session/goal", actions: ["set", "clear"],
  };
  it("preserves action subsets without adding pause or budget controls", () => {
    expect(acpxGoalProjection(capability, null, false).sessionGoals).toMatchObject({
      availability: "available", actions: ["set", "clear"], tokenBudgetControl: false,
    });
  });
  it.each([
    null,
    { ...capability, version: 2 },
    { ...capability, controlMethod: "_arbitrary" },
    { ...capability, actions: ["set"] as const },
  ])("rejects missing or incompatible extensions (%j)", (value) => {
    expect(acpxGoalProjection(value as AcpxRuntimeGoalCapability | null, null, false).sessionGoals)
      .toMatchObject({ availability: "unsupported", actions: [] });
  });
  it("normalizes nullable usage, ISO timestamps, and out-of-prompt limited status", () => {
    const projection = acpxGoalProjection(capability, {
      objective: "Complete the task", status: "limited", createdAt: 0,
      updatedAt: "2026-09-08T00:00:00Z",
    }, false);
    expect(projection.goal).toEqual({
      objective: "Complete the task", status: "limited", tokenBudget: null,
      tokensUsed: null, elapsedSeconds: null, iterations: null, lastReason: null,
      createdAt: "1970-01-01T00:00:00.000Z", updatedAt: "2026-09-08T00:00:00.000Z",
      completedAt: null, workingNow: false,
    });
  });
});
