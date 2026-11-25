import { describe, expect, it } from "vitest";
import { selectDefaultCompanyGoalId } from "./onboarding-launch";

describe("selectDefaultCompanyGoalId", () => {
  it("prefers the earliest active root company goal", () => {
    expect(
      selectDefaultCompanyGoalId([
        {
          id: "team-goal",
          companyId: "company-1",
          title: "Nested",
          description: null,
          level: "team",
          status: "active",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-04T00:00:00Z"),
          updatedAt: new Date("2026-03-04T00:00:00Z"),
        },
        {
          id: "goal-2",
          companyId: "company-1",
          title: "Later active root",
          description: null,
          level: "company",
          status: "active",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-03T00:00:00Z"),
          updatedAt: new Date("2026-03-03T00:00:00Z"),
        },
        {
          id: "goal-1",
          companyId: "company-1",
          title: "Earliest active root",
          description: null,
          level: "company",
          status: "active",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-02T00:00:00Z"),
          updatedAt: new Date("2026-03-02T00:00:00Z"),
        },
      ]),
    ).toBe("goal-1");
  });

  it("falls back to the earliest root company goal when none are active", () => {
    expect(
      selectDefaultCompanyGoalId([
        {
          id: "goal-2",
          companyId: "company-1",
          title: "Cancelled root",
          description: null,
          level: "company",
          status: "cancelled",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-03T00:00:00Z"),
          updatedAt: new Date("2026-03-03T00:00:00Z"),
        },
        {
          id: "goal-1",
          companyId: "company-1",
          title: "Earliest root",
          description: null,
          level: "company",
          status: "planned",
          parentId: null,
          ownerAgentId: null,
          createdAt: new Date("2026-03-02T00:00:00Z"),
          updatedAt: new Date("2026-03-02T00:00:00Z"),
        },
      ]),
    ).toBe("goal-1");
  });
});
