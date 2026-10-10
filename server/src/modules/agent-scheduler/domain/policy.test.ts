import { describe, expect, it } from "vitest";
import {
  decideAgentRunMaterialization,
  resolveEffectiveAgentCapacity,
} from "./policy.js";

describe("agent-scheduler policy", () => {
  it("keeps configured capacity when scheduler is disabled", () => {
    expect(
      resolveEffectiveAgentCapacity({
        schedulerEnabled: false,
        allowParallelExecution: false,
        configuredMaxConcurrentRuns: 20,
        runningRunCount: 0,
      }),
    ).toBe(20);
  });

  it("defaults to serial capacity 1 when scheduler is enabled", () => {
    expect(
      resolveEffectiveAgentCapacity({
        schedulerEnabled: true,
        allowParallelExecution: false,
        configuredMaxConcurrentRuns: 20,
        runningRunCount: 0,
      }),
    ).toBe(1);
  });

  it("honors explicit parallel override when scheduler is enabled", () => {
    expect(
      resolveEffectiveAgentCapacity({
        schedulerEnabled: true,
        allowParallelExecution: true,
        configuredMaxConcurrentRuns: 3,
        runningRunCount: 0,
      }),
    ).toBe(3);
  });

  it("parks runnable work when agent is at capacity", () => {
    expect(
      decideAgentRunMaterialization({
        schedulerEnabled: true,
        allowParallelExecution: false,
        configuredMaxConcurrentRuns: 20,
        runningRunCount: 1,
      }),
    ).toEqual({
      kind: "park_runnable",
      effectiveCapacity: 1,
      reason: "agent_at_capacity",
    });
  });

  it("materializes when a slot is available", () => {
    expect(
      decideAgentRunMaterialization({
        schedulerEnabled: true,
        allowParallelExecution: false,
        configuredMaxConcurrentRuns: 20,
        runningRunCount: 0,
      }),
    ).toEqual({ kind: "materialize" });
  });
});
