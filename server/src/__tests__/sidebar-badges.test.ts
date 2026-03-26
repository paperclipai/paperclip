import { describe, expect, it } from "vitest";
import {
  computeSidebarAlertsCount,
  computeSidebarInboxCount,
} from "../services/sidebar-badges.ts";

describe("computeSidebarInboxCount", () => {
  it("includes approvals, failed runs, joins, unread issues, and alerts", () => {
    expect(
      computeSidebarInboxCount({
        approvals: 2,
        failedRuns: 1,
        joinRequests: 3,
        unreadTouchedIssues: 4,
        alerts: 1,
      }),
    ).toBe(11);
  });
});

describe("computeSidebarAlertsCount", () => {
  const base = {
    agentErrorCount: 1,
    hasFailedRuns: false,
    monthBudgetCents: 100,
    monthUtilizationPercent: 85,
    dismissedAlertItemIds: new Set<string>(),
  };

  it("counts agent-error and budget alerts when conditions hold", () => {
    expect(computeSidebarAlertsCount(base)).toBe(2);
  });

  it("skips agent-error alert when latest runs failed", () => {
    expect(computeSidebarAlertsCount({ ...base, hasFailedRuns: true })).toBe(1);
  });

  it("respects persisted dismissals for sidebar badge parity with inbox UI", () => {
    expect(
      computeSidebarAlertsCount({
        ...base,
        dismissedAlertItemIds: new Set(["agent-errors", "budget"]),
      }),
    ).toBe(0);
  });
});

