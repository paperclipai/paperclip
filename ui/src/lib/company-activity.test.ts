// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  COMPANY_ACTIVITY_POLL_INTERVAL_MS,
  getCompanyActivityRefetchInterval,
  normalizeActivityListFilters,
} from "./company-activity";

describe("company activity helpers", () => {
  it("pauses polling while the page is hidden", () => {
    expect(getCompanyActivityRefetchInterval({ isDocumentVisible: false })).toBe(false);
  });

  it("polls at the normal cadence while the page is visible", () => {
    expect(getCompanyActivityRefetchInterval({ isDocumentVisible: true })).toBe(COMPANY_ACTIVITY_POLL_INTERVAL_MS);
  });

  it("drops blank and all-valued filters before sending requests", () => {
    expect(
      normalizeActivityListFilters({
        agentId: " ",
        entityType: "all",
        action: "",
      }),
    ).toEqual({});
  });

  it("keeps concrete filter values for server-side activity queries", () => {
    expect(
      normalizeActivityListFilters({
        agentId: "agent-1",
        entityType: "issue",
        action: "issue.updated",
      }),
    ).toEqual({
      agentId: "agent-1",
      entityType: "issue",
      action: "issue.updated",
    });
  });
});
