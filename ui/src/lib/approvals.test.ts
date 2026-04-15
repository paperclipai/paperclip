import { describe, expect, it } from "vitest";
import type { Approval } from "@paperclipai/shared";
import { approvalAgeHours, approvalLane, approvalNeedsReminder } from "./approvals";

function makeApproval(
  overrides: Partial<Approval> & { payload?: Record<string, unknown> } = {},
): Approval {
  return {
    id: "appr-1",
    companyId: "co-1",
    type: "approve_ceo_strategy",
    requestedByAgentId: null,
    requestedByUserId: "user-1",
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    scheduledAt: null,
    publishedAt: null,
    createdAt: new Date("2026-03-27T00:00:00.000Z"),
    updatedAt: new Date("2026-03-27T00:00:00.000Z"),
    ...overrides,
  };
}

describe("approval lane classification", () => {
  it("classifies marketing flow from social payload", () => {
    const approval = makeApproval({
      payload: { channel: "linkedin+x", title: "Launch social pack" },
    });
    expect(approvalLane(approval)).toBe("marketing");
  });

  it("classifies intake flow from wind-tech intake payload", () => {
    const approval = makeApproval({
      payload: { title: "Wind Tech intake validation" },
    });
    expect(approvalLane(approval)).toBe("intake");
  });
});

describe("approval aging", () => {
  it("marks reminders after 24h and reports age hours", () => {
    const approval = makeApproval({
      updatedAt: new Date("2026-03-25T00:00:00.000Z"),
      status: "revision_requested",
    });
    const now = Date.parse("2026-03-27T06:00:00.000Z");
    expect(approvalNeedsReminder(approval, now)).toBe(true);
    expect(approvalAgeHours(approval, now)).toBe(54);
  });
});
