import { describe, expect, it } from "vitest";
import type { ChatActivityItem } from "@/api/chatEndpoints";
import {
  isIndividuallyToggleableResource,
  isReplayEligible,
  isResolutionEligible,
} from "./ChatEndpointDetail";

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
  it.each([activity(), activity({ kind: "publication" })])(
    "allows server-approved failed activity %#",
    (item) => {
      expect(isReplayEligible(item)).toBe(true);
    },
  );

  it.each([
    activity({ replayable: false }),
    activity({ replayable: undefined }),
    activity({ status: "processed" }),
    activity({ kind: "delivery", status: "delivery_unknown" }),
    activity({ kind: "publication", status: "delivery_unknown" }),
    activity({ kind: "health" }),
    activity({ kind: "repair" }),
  ])("hides replay for ineligible activity %#", (item) => {
    expect(isReplayEligible(item)).toBe(false);
  });
});

describe("chat endpoint ambiguous-delivery resolution eligibility", () => {
  it.each([
    activity({
      kind: "publication",
      status: "delivery_unknown",
      replayable: false,
      resolutionActions: ["mark_delivered", "retry_anyway", "cancel"],
    }),
    activity({
      kind: "action",
      actionType: "provider_effect",
      status: "delivery_unknown",
      replayable: false,
      resolutionActions: ["mark_delivered", "retry_anyway", "cancel"],
    }),
  ])("shows explicit resolution for server-approved activity %#", (item) => {
    expect(isResolutionEligible(item)).toBe(true);
  });

  it.each([
    activity({ kind: "action", status: "processed" }),
    activity({
      kind: "action",
      status: "delivery_unknown",
      resolutionActions: [],
    }),
    activity({
      kind: "delivery",
      status: "delivery_unknown",
      resolutionActions: ["cancel"],
    }),
  ])("hides resolution when the server did not offer it %#", (item) => {
    expect(isResolutionEligible(item)).toBe(false);
  });
});

describe("chat endpoint destination controls", () => {
  it("uses the reach toggles instead of meaningless Teams DM/group rows", () => {
    expect(
      isIndividuallyToggleableResource("microsoft-teams", "direct_message"),
    ).toBe(false);
    expect(
      isIndividuallyToggleableResource("microsoft-teams", "group_chat"),
    ).toBe(false);
    expect(isIndividuallyToggleableResource("microsoft-teams", "channel")).toBe(
      true,
    );
  });

  it("retains individually discovered destinations for other providers", () => {
    expect(isIndividuallyToggleableResource("slack", "direct_message")).toBe(
      true,
    );
    expect(isIndividuallyToggleableResource("telegram", "direct_message")).toBe(
      true,
    );
    expect(isIndividuallyToggleableResource("github", "repository")).toBe(true);
  });
});
