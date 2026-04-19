import { describe, expect, it, vi } from "vitest";
import { companyService } from "../services/companies.js";

describe("services/companies.ts", () => {
  it("returns null when getById does not find a company", async () => {
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    };

    const service = companyService(db as any);
    await expect(service.getById("missing-company")).resolves.toBeNull();
  });

  it("hydrates list results with monthly spend and logo URL", async () => {
    const companyRows = [
      {
        id: "company-1",
        name: "Paperclip",
        description: null,
        status: "active",
        issuePrefix: "PAP",
        issueCounter: 1,
        budgetMonthlyCents: 1000,
        spentMonthlyCents: 0,
        requireBoardApprovalForNewAgents: false,
        feedbackDataSharingEnabled: false,
        feedbackDataSharingConsentAt: null,
        feedbackDataSharingConsentByUserId: null,
        feedbackDataSharingTermsVersion: null,
        brandColor: null,
        logoAssetId: "asset-1",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ];
    const spendRows = [{ companyId: "company-1", spentMonthlyCents: 275 }];
    const select = vi
      .fn()
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn().mockResolvedValue(companyRows),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            groupBy: vi.fn().mockResolvedValue(spendRows),
          })),
        })),
      }));
    const db = { select };

    const service = companyService(db as any);
    const rows = await service.list();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "company-1",
      spentMonthlyCents: 275,
      logoUrl: "/api/assets/asset-1/content",
    });
  });

  it("aggregates stats across companies even when one side is missing", async () => {
    const select = vi
      .fn()
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          groupBy: vi.fn().mockResolvedValue([
            { companyId: "company-1", count: 3 },
          ]),
        })),
      }))
      .mockImplementationOnce(() => ({
        from: vi.fn(() => ({
          groupBy: vi.fn().mockResolvedValue([
            { companyId: "company-1", count: 5 },
            { companyId: "company-2", count: 1 },
          ]),
        })),
      }));
    const db = { select };

    const service = companyService(db as any);
    const stats = await service.stats();

    expect(stats).toEqual({
      "company-1": { agentCount: 3, issueCount: 5 },
      "company-2": { agentCount: 0, issueCount: 1 },
    });
  });
});

