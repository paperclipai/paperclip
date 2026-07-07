import { describe, expect, it } from "vitest";
import { buildProjectListMetricMaps, buildTaskCountRows } from "../services/projects.ts";

describe("buildProjectListMetricMaps", () => {
  it("maps task counts by project, coercing string counts to numbers", () => {
    const { taskCountByProjectId } = buildProjectListMetricMaps(
      [
        { projectId: "p1", count: 24 },
        { projectId: "p2", count: 11 as unknown as number },
      ],
      [],
    );

    expect(taskCountByProjectId.get("p1")).toBe(24);
    expect(taskCountByProjectId.get("p2")).toBe(11);
  });

  it("ignores task-count rows with a null project id", () => {
    const { taskCountByProjectId } = buildProjectListMetricMaps(
      [{ projectId: null, count: 5 }],
      [],
    );

    expect(taskCountByProjectId.size).toBe(0);
  });

  it("builds task counts from issue project memberships without double-counting legacy primary rows", () => {
    const rows = buildTaskCountRows([
      { projectId: "p1", issueId: "i1" },
      { projectId: "p2", issueId: "i1" },
      { projectId: "p1", issueId: "i1" },
      { projectId: "p2", issueId: "i2" },
      { projectId: null, issueId: "i3" },
    ]);

    const { taskCountByProjectId } = buildProjectListMetricMaps(rows, []);

    expect(taskCountByProjectId.get("p1")).toBe(1);
    expect(taskCountByProjectId.get("p2")).toBe(2);
    expect(taskCountByProjectId.size).toBe(2);
  });

  it("maps positive budgets with their window kind", () => {
    const { budgetByProjectId } = buildProjectListMetricMaps(
      [],
      [
        { scopeId: "p1", amount: 120_000, windowKind: "calendar_month_utc" },
        { scopeId: "p2", amount: 50_000, windowKind: "lifetime" },
      ],
    );

    expect(budgetByProjectId.get("p1")).toEqual({ amountCents: 120_000, windowKind: "calendar_month_utc" });
    expect(budgetByProjectId.get("p2")).toEqual({ amountCents: 50_000, windowKind: "lifetime" });
  });

  it("omits zero/negative budgets so they do not surface as 'set'", () => {
    const { budgetByProjectId } = buildProjectListMetricMaps(
      [],
      [
        { scopeId: "p1", amount: 0, windowKind: "lifetime" },
        { scopeId: "p2", amount: -10, windowKind: "lifetime" },
      ],
    );

    expect(budgetByProjectId.size).toBe(0);
  });
});
