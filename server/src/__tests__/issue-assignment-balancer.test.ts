import { describe, expect, it } from "vitest";
import {
  rankAssignmentCandidates,
  type AssignmentBalancerConfig,
} from "../services/issue-assignment-balancer.js";

const baseConfig: AssignmentBalancerConfig = {
  enabled: true,
  shadowMode: false,
  criticalCapPerAgent: 3,
  staleBlockThreshold: 2,
  roleFitWeight: 40,
  capacityHeadroomWeight: 30,
  projectFamiliarityWeight: 10,
  fairnessRotationWeight: 10,
  criticalOverloadPenalty: 25,
  staleBlockPenalty: 10,
  excludeRoles: ["ceo"],
};

describe("rankAssignmentCandidates", () => {
  it("avoids selecting critical-overloaded lanes when alternatives exist", () => {
    const result = rankAssignmentCandidates({
      candidates: [
        {
          agentId: "a-overloaded",
          agentName: "Overloaded",
          role: "engineer",
          counts: { running: 0, queued: 1, criticalOpen: 4, blocked: 0 },
          limits: { maxRunning: 3, maxQueued: 6 },
          projectFamiliarityCount: 1,
          lastAssignedAt: new Date("2026-03-06T00:05:00.000Z"),
        },
        {
          agentId: "b-healthy",
          agentName: "Healthy",
          role: "engineer",
          counts: { running: 0, queued: 1, criticalOpen: 1, blocked: 0 },
          limits: { maxRunning: 3, maxQueued: 6 },
          projectFamiliarityCount: 0,
          lastAssignedAt: new Date("2026-03-05T23:05:00.000Z"),
        },
      ],
      targetStatus: "todo",
      priority: "critical",
      projectId: null,
      config: baseConfig,
    });

    expect(result.selectedAgentId).toBe("b-healthy");
    expect(result.topCandidates[0]?.agentId).toBe("b-healthy");
  });

  it("excludes ceo role by default config", () => {
    const result = rankAssignmentCandidates({
      candidates: [
        {
          agentId: "ceo-id",
          agentName: "CEO",
          role: "ceo",
          counts: { running: 0, queued: 0, criticalOpen: 0, blocked: 0 },
          limits: { maxRunning: 3, maxQueued: 6 },
          projectFamiliarityCount: 0,
          lastAssignedAt: new Date("2026-03-05T22:00:00.000Z"),
        },
        {
          agentId: "eng-id",
          agentName: "Engineer",
          role: "engineer",
          counts: { running: 0, queued: 0, criticalOpen: 0, blocked: 0 },
          limits: { maxRunning: 3, maxQueued: 6 },
          projectFamiliarityCount: 0,
          lastAssignedAt: new Date("2026-03-05T22:10:00.000Z"),
        },
      ],
      targetStatus: "todo",
      priority: "high",
      projectId: null,
      config: baseConfig,
    });

    expect(result.selectedAgentId).toBe("eng-id");
    expect(result.excludedCandidates).toContainEqual({
      agentId: "ceo-id",
      reason: "excluded_role",
    });
  });

  it("applies deterministic tie-breaker when scores are equal", () => {
    const result = rankAssignmentCandidates({
      candidates: [
        {
          agentId: "b-agent",
          agentName: "B",
          role: "engineer",
          counts: { running: 0, queued: 0, criticalOpen: 0, blocked: 0 },
          limits: { maxRunning: null, maxQueued: null },
          projectFamiliarityCount: 0,
          lastAssignedAt: new Date("2026-03-05T22:00:00.000Z"),
        },
        {
          agentId: "a-agent",
          agentName: "A",
          role: "engineer",
          counts: { running: 0, queued: 0, criticalOpen: 0, blocked: 0 },
          limits: { maxRunning: null, maxQueued: null },
          projectFamiliarityCount: 0,
          lastAssignedAt: new Date("2026-03-05T22:00:00.000Z"),
        },
      ],
      targetStatus: "todo",
      priority: "high",
      projectId: null,
      config: baseConfig,
    });

    expect(result.selectedAgentId).toBe("a-agent");
  });
});
