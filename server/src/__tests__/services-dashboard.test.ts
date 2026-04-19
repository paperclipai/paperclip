import { describe, expect, it, vi } from "vitest";

function createDbWithMissingCompany() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([]),
      })),
    })),
  };
}

describe("services/dashboard.ts", () => {
  it("throws notFound when company is missing", async () => {
    const { dashboardService } = await import("../services/dashboard.js");
    const service = dashboardService(createDbWithMissingCompany() as any);
    await expect(service.summary("missing-company")).rejects.toThrow("Company not found");
  });
});

