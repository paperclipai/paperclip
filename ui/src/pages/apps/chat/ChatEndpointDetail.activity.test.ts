import { describe, expect, it } from "vitest";
import type { ChatActivityItem, ChatEndpointStatus } from "@/api/chatEndpoints";
import {
  connectionHealthPresentation,
  isIndividuallyToggleableResource,
  isReplayEligible,
  isResolutionEligible,
  activityResolutionActions,
  activityResolutionDescription,
} from "./ChatEndpointDetail";

describe("chat endpoint lifecycle health presentation", () => {
  it.each<[ChatEndpointStatus, string]>([
    ["paused", "Connection is paused. Resume it to receive new messages."],
    ["draft", "Connection setup is incomplete."],
    ["verifying", "Connection verification is in progress."],
    ["attention", "Connection needs attention."],
    ["revoked", "Connection access is revoked. Reconnect to verify access."],
    ["archived", "Connection has been removed from Paperclip."],
  ])("prioritizes %s over stale connected health", (status, message) => {
    const presentation = connectionHealthPresentation({
      status,
      healthMessage: "Connected",
      lastError: null,
    });
    expect(presentation.message).toBe(message);
    expect(presentation.previousHealth).toBe("Connected");
    expect(presentation.error).toBeNull();
  });

  it("shows the paused lifecycle even without a previous health event", () => {
    expect(connectionHealthPresentation({ status: "paused" }).message).toBe(
      "Connection is paused. Resume it to receive new messages.",
    );
  });

  it.each(["paused", "draft", "verifying", "archived"] as const)(
    "labels retained errors as historical while %s",
    (status) => {
      expect(
        connectionHealthPresentation({
          status,
          lastError: "Gateway timed out",
        }),
      ).toMatchObject({
        error: "Gateway timed out",
        errorLabel: "Last reported error",
      });
    },
  );

  it.each(["active", "attention", "revoked"] as const)(
    "preserves current error details while %s",
    (status) => {
      expect(
        connectionHealthPresentation({ status, lastError: "Access denied" }),
      ).toMatchObject({ error: "Access denied", errorLabel: "Reason" });
    },
  );

  it("preserves active health and does not invent a connected state", () => {
    expect(
      connectionHealthPresentation({
        status: "active",
        healthMessage: "Reconnecting",
      }),
    ).toMatchObject({ message: "Reconnecting", previousHealth: null });
    expect(connectionHealthPresentation({ status: "active" })).toMatchObject({
      message: null,
      previousHealth: null,
      error: null,
    });
  });
});

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
  it("uses server-offered stage-aware file notification actions only", () => {
    const item = activity({
      kind: "publication",
      status: "delivery_unknown",
      fileTransfer: {
        provider: "microsoft-teams",
        phase: "file_info_unknown",
        filename: "report.txt",
        version: 3,
      },
      resolutionActions: ["retry_anyway"],
    });
    expect(activityResolutionActions(item)).toEqual(["retry_anyway"]);
    expect(activityResolutionDescription(item)).toContain("not the file bytes");
    expect(
      activityResolutionActions({ ...item, resolutionActions: [] }),
    ).toEqual([]);
    expect(
      activityResolutionActions({
        ...item,
        fileTransfer: { ...item.fileTransfer!, version: 0 },
      }),
    ).toEqual([]);
    expect(isResolutionEligible({ ...item, status: "awaiting_consent" })).toBe(
      false,
    );
  });
  it.each(["consent_unknown", "upload_unknown", "conflict"] as const)(
    "suppresses generic delivery/retry resolution for Teams %s",
    (phase) => {
      const fileTransfer = {
        provider: "microsoft-teams" as const,
        phase,
        filename: "report.txt",
        version: 2,
      };
      expect(
        isResolutionEligible(
          activity({
            kind: "publication",
            status: "delivery_unknown",
            fileTransfer,
            resolutionActions: ["mark_delivered", "retry_anyway"],
          }),
        ),
      ).toBe(false);
      expect(
        isResolutionEligible(
          activity({
            kind: "publication",
            status: "delivery_unknown",
            fileTransfer,
            resolutionActions: ["cancel"],
          }),
        ),
      ).toBe(true);
      expect(
        isReplayEligible(activity({ kind: "publication", fileTransfer })),
      ).toBe(false);
    },
  );
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
