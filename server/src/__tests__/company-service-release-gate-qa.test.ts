import { describe, expect, it, vi } from "vitest";
import { companyService } from "../services/companies.ts";

function createUpdateStubDb(results: unknown[]) {
  const pending = [...results];
  const chain = {
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    groupBy: vi.fn(() => chain),
    then: vi.fn((resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(pending.shift() ?? []))),
  };

  const tx = {
    select: vi.fn(() => chain),
    update: vi.fn(() => {
      throw new Error("update should not be reached");
    }),
    insert: vi.fn(() => {
      throw new Error("insert should not be reached");
    }),
    delete: vi.fn(() => {
      throw new Error("delete should not be reached");
    }),
  };

  return {
    db: {
      transaction: (callback: (innerTx: typeof tx) => Promise<unknown>) => callback(tx),
    },
    tx,
  };
}

describe("companyService release-gate QA validation", () => {
  it("rejects configuring an errored QA agent as the release-gate owner", async () => {
    const dbStub = createUpdateStubDb([
      [{
        id: "company-1",
        name: "PrivateClip",
        description: null,
        status: "active",
        pauseReason: null,
        pausedAt: null,
        issuePrefix: "PAP",
        issueCounter: 1,
        roadmapPath: null,
        budgetMonthlyCents: 0,
        spentMonthlyCents: 0,
        releaseGateQaAgentId: null,
        requireBoardApprovalForNewAgents: false,
        feedbackDataSharingEnabled: false,
        feedbackDataSharingConsentAt: null,
        feedbackDataSharingConsentByUserId: null,
        feedbackDataSharingTermsVersion: null,
        dailyExecutiveSummaryEnabled: false,
        criticalBoardAlertsEmailEnabled: false,
        dailyExecutiveSummaryLastSentAt: null,
        dailyExecutiveSummaryLastStatus: null,
        dailyExecutiveSummaryLastError: null,
        brandColor: null,
        logoAssetId: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      }],
      [{
        id: "agent-qa-error",
        companyId: "company-1",
        role: "qa",
        status: "error",
      }],
    ]);

    const companies = companyService(dbStub.db as any);

    await expect(
      companies.update("company-1", { releaseGateQaAgentId: "agent-qa-error" }),
    ).rejects.toThrow("Configured release-gate QA owner must be an active or resumable QA agent");
    expect(dbStub.tx.update).not.toHaveBeenCalled();
  });
});
