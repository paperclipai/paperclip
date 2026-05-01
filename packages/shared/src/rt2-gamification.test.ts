import { describe, expect, it } from "vitest";
import {
  deriveRt2CareerProgression,
  type Rt2CareerProgression,
  type Rt2CareerProgressionInput,
} from "./index.js";

const now = new Date("2026-05-01T00:00:00.000Z");

function derive(input: Partial<Rt2CareerProgressionInput> = {}): Rt2CareerProgression {
  return deriveRt2CareerProgression(
    {
      companyId: "company-1",
      agentId: "agent-1",
      totalXp: 0,
      earnedGold: 0,
      ledgerEarnedGold: 0,
      approvedSettlementGold: 0,
      gamificationGoldBalance: null,
      qualityAverage: null,
      qualitySampleCount: 0,
      approvedSettlementCount: 0,
      rejectedSettlementCount: 0,
      flaggedSettlementCount: 0,
      highRiskSettlementCount: 0,
      portfolioCount: 0,
      milestoneCount: 0,
      achievementsCount: 0,
      sourceLinks: [],
      ...input,
    },
    now,
  );
}

describe("RT2 gamification and CareerMate contracts", () => {
  it("derives ready CareerMate progression from ledger, settlement, quality, XP, and portfolio evidence", () => {
    const progression = derive({
      totalXp: 900,
      earnedGold: 2_800,
      ledgerEarnedGold: 2_800,
      approvedSettlementGold: 3_000,
      gamificationGoldBalance: 2_800,
      qualityAverage: 92,
      qualitySampleCount: 5,
      approvedSettlementCount: 4,
      portfolioCount: 4,
      milestoneCount: 1,
      achievementsCount: 3,
    });

    expect(progression).toEqual(
      expect.objectContaining({
        evidenceStatus: "ready",
        tier: "operator",
        reputationBand: "trusted",
        avatarState: "trusted",
        progressScore: 208,
        level: 6,
        calculatedAt: "2026-05-01T00:00:00.000Z",
      }),
    );
    expect(progression.nextMilestone).toEqual({
      tier: "expert",
      scoreRequired: 250,
      scoreRemaining: 42,
    });
    expect(progression.evidence).toEqual(
      expect.objectContaining({
        ledgerEarnedGold: 2800,
        approvedSettlementGold: 3000,
        qualityAverage: 92,
        qualitySampleCount: 5,
      }),
    );
  });

  it("marks rejected or high-risk settlement evidence as review-required and suppresses trust band", () => {
    const progression = derive({
      totalXp: 600,
      earnedGold: 1_200,
      ledgerEarnedGold: 1_200,
      approvedSettlementGold: 1_000,
      qualityAverage: 80,
      qualitySampleCount: 1,
      approvedSettlementCount: 1,
      rejectedSettlementCount: 1,
      flaggedSettlementCount: 2,
      highRiskSettlementCount: 1,
      portfolioCount: 1,
      achievementsCount: 1,
    });

    expect(progression.evidenceStatus).toBe("review_required");
    expect(progression.reputationBand).toBe("review");
    expect(progression.avatarState).toBe("review");
    expect(progression.progressScore).toBe(80);
    expect(progression.warnings.join(" ")).toContain("Rejected settlements");
    expect(progression.warnings.join(" ")).toContain("Anti-gaming");
  });

  it("does not present missing evidence as proven CareerMate progress", () => {
    const progression = derive();

    expect(progression).toEqual(
      expect.objectContaining({
        evidenceStatus: "missing",
        tier: "starter",
        reputationBand: "unproven",
        avatarState: "seed",
        progressScore: 0,
        level: 1,
      }),
    );
    expect(progression.warnings[0]).toContain("no ledger, settlement, quality, or achievement evidence");
  });
});
