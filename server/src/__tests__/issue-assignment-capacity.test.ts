import { describe, expect, it } from "vitest";
import {
  assignmentCapacityTargetForStatus,
  evaluateAssignmentCapacity,
  resolveAssignmentCapacityLimits,
} from "../services/issue-assignment-capacity.js";

const baseConfig = {
  defaultMaxRunning: null,
  defaultMaxQueued: null,
  foundingEngineerNameKey: "founding engineer",
  foundingEngineerLegacyOpenCap: 3,
  foundingEngineerMaxRunning: null,
  foundingEngineerMaxQueued: null,
};

describe("assignmentCapacityTargetForStatus", () => {
  it("maps in_progress to running and todo to queued", () => {
    expect(assignmentCapacityTargetForStatus("in_progress")).toBe("running");
    expect(assignmentCapacityTargetForStatus("todo")).toBe("queued");
    expect(assignmentCapacityTargetForStatus("backlog")).toBeNull();
  });
});

describe("resolveAssignmentCapacityLimits", () => {
  it("uses per-agent runtime assignment config when present", () => {
    const limits = resolveAssignmentCapacityLimits({
      agentName: "ops",
      runtimeConfig: {
        assignment: {
          maxRunningIssues: 2,
          maxQueuedIssues: 5,
        },
      },
      config: baseConfig,
    });
    expect(limits).toEqual({ maxRunning: 2, maxQueued: 5 });
  });

  it("falls back to global defaults for non-Founding Engineer agents", () => {
    const limits = resolveAssignmentCapacityLimits({
      agentName: "inventory",
      runtimeConfig: {},
      config: {
        ...baseConfig,
        defaultMaxRunning: 1,
        defaultMaxQueued: 4,
      },
    });
    expect(limits).toEqual({ maxRunning: 1, maxQueued: 4 });
  });

  it("keeps Founding Engineer legacy behavior as running + queued fallback", () => {
    const limits = resolveAssignmentCapacityLimits({
      agentName: "Founding Engineer",
      runtimeConfig: {},
      config: baseConfig,
    });
    expect(limits).toEqual({ maxRunning: 1, maxQueued: 2 });
  });
});

describe("evaluateAssignmentCapacity", () => {
  it("returns running-cap violation details", () => {
    const violation = evaluateAssignmentCapacity({
      target: "running",
      counts: { running: 1, queued: 0 },
      limits: { maxRunning: 1, maxQueued: 5 },
    });
    expect(violation).toEqual({
      code: "assignment_capacity_exceeded",
      reason: "max_running_reached",
      attemptedState: "running",
      message: "Running capacity reached (1/1 in_progress tasks).",
    });
  });

  it("returns queued-cap violation details", () => {
    const violation = evaluateAssignmentCapacity({
      target: "queued",
      counts: { running: 0, queued: 4 },
      limits: { maxRunning: 1, maxQueued: 4 },
    });
    expect(violation).toEqual({
      code: "assignment_capacity_exceeded",
      reason: "max_queued_reached",
      attemptedState: "queued",
      message: "Queued capacity reached (4/4 todo tasks).",
    });
  });

  it("returns null when under capacity", () => {
    const violation = evaluateAssignmentCapacity({
      target: "queued",
      counts: { running: 0, queued: 1 },
      limits: { maxRunning: 1, maxQueued: 4 },
    });
    expect(violation).toBeNull();
  });
});
