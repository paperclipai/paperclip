import { describe, expect, it } from "vitest";
import { summarizeMicroRegistry, formatExperimentWindow } from "./micro-registry";
import type { MicroRegistryOverview } from "@paperclipai/shared";

const overview: MicroRegistryOverview = {
  pods: [
    { id: "p1", companyId: "c1", paperclipIssueId: null, identifier: "MPOD-FX", title: "FX", source: "operator", thesis: "x", ownerAgentId: null, lifecycleState: "draft", improvementAttemptCount: 0, dependencies: [], createdAt: "2026-06-20T00:00:00.000Z", updatedAt: "2026-06-20T00:00:00.000Z", closedAt: null },
  ],
  experiments: [
    { id: "e1", companyId: "c1", podId: "p1", paperclipIssueId: null, identifier: "MEXP-FX", title: "FX exp", hypothesis: "h", sourceKind: "operator", sourceUrl: null, lifecycleState: "draft", maxImprovementAttempts: 5, improvementAttemptCount: 0, overnightAllowed: false, holdingPeriodMinMinutes: 1, holdingPeriodMaxMinutes: 390, metrics: {}, verdict: null, verdictReason: null, evidencePackId: null, promotionRequestId: null, createdAt: "2026-06-20T00:00:00.000Z", updatedAt: "2026-06-20T00:00:00.000Z", closedAt: null },
    { id: "e2", companyId: "c1", podId: "p1", paperclipIssueId: null, identifier: "MEXP-KILL", title: "Killed", hypothesis: "h", sourceKind: "paper", sourceUrl: null, lifecycleState: "killed", maxImprovementAttempts: 5, improvementAttemptCount: 5, overnightAllowed: false, holdingPeriodMinMinutes: 1, holdingPeriodMaxMinutes: 30, metrics: {}, verdict: "kill", verdictReason: "no edge", evidencePackId: null, promotionRequestId: null, createdAt: "2026-06-20T00:00:00.000Z", updatedAt: "2026-06-20T00:00:00.000Z", closedAt: null },
  ],
  dependencyRequests: [
    { id: "d1", companyId: "c1", podId: "p1", experimentId: "e1", kind: "evidence_preregistration", title: "Gate", description: null, status: "open", routedToAgentId: null, paperclipIssueId: null, metadata: {}, createdAt: "2026-06-20T00:00:00.000Z", updatedAt: "2026-06-20T00:00:00.000Z", resolvedAt: null },
  ],
  evidencePacks: [
    { id: "ev1", companyId: "c1", podId: "p1", experimentId: "e1", title: "Evidence", status: "draft", artifactUri: "file:///tmp/evidence.md", summary: null, metadata: {}, createdAt: "2026-06-20T00:00:00.000Z", updatedAt: "2026-06-20T00:00:00.000Z" },
  ],
  promotionRequests: [],
};

describe("micro registry presentation", () => {
  it("summarizes factory state without treating killed experiments as active", () => {
    expect(summarizeMicroRegistry(overview)).toEqual({
      pods: 1,
      activeExperiments: 1,
      openDependencies: 1,
      evidencePacks: 1,
      promotionRequests: 0,
    });
  });

  it("formats day-trading holding windows", () => {
    expect(formatExperimentWindow(overview.experiments[0])).toBe("1m → EOD");
    expect(formatExperimentWindow(overview.experiments[1])).toBe("1m → 30m");
  });
});
