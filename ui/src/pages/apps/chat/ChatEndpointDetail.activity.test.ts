import { describe, expect, it } from "vitest";
import type { ChatActivityItem } from "@/api/chatEndpoints";
import { isReplayEligible } from "./ChatEndpointDetail";

function activity(overrides: Partial<ChatActivityItem> = {}): ChatActivityItem {
  return {
    id: "activity-1",
    kind: "delivery",
    status: "failed",
    summary: "Delivery failed",
    createdAt: "2026-09-05T12:00:00.000Z",
    replayable: true,
    ...overrides,
  };
}

describe("chat endpoint activity replay eligibility", () => {
  it.each([
    activity(),
    activity({ kind: "publication" }),
    activity({ kind: "publication", status: "delivery_unknown" }),
  ])("allows server-approved failed activity %#", (item) => {
    expect(isReplayEligible(item)).toBe(true);
  });

  it.each([
    activity({ replayable: false }),
    activity({ replayable: undefined }),
    activity({ status: "processed" }),
    activity({ kind: "delivery", status: "delivery_unknown" }),
    activity({ kind: "health" }),
    activity({ kind: "repair" }),
  ])("hides replay for ineligible activity %#", (item) => {
    expect(isReplayEligible(item)).toBe(false);
  });
});
