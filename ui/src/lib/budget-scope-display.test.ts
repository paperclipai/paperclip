import { describe, expect, it } from "vitest";
import { budgetSectionDescription, incidentPauseMessage, pausedSummaryLine } from "./budget-scope-display";

describe("budget scope display helpers", () => {
  it("describes seat budget sections", () => {
    expect(budgetSectionDescription("seat")).toBe("Recurring monthly spend policies for stable operating seats.");
  });

  it("includes seat pause count in summary line", () => {
    expect(pausedSummaryLine({ pausedAgentCount: 1, pausedSeatCount: 2, pausedProjectCount: 3 })).toBe(
      "1 agent paused · 2 seats paused · 3 projects paused",
    );
  });

  it("renders seat-specific incident pause copy", () => {
    expect(incidentPauseMessage({ scopeType: "seat" })).toContain("seat is paused");
  });
});
