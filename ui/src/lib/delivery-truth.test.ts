import { describe, expect, it } from "vitest";
import type { DeliverySnapshotV1 } from "@paperclipai/shared";
import {
  deliveryAuthorityPresentation,
  deliverySnapshotFreshness,
  deliveryStageLabel,
} from "./delivery-truth";

describe("delivery truth presentation", () => {
  it("keeps provider facts visually distinct from unverified claims", () => {
    expect(deliveryAuthorityPresentation("provider_verified")).toMatchObject({
      label: "Provider verified",
      tone: "verified",
    });
    expect(deliveryAuthorityPresentation("user_asserted")).toMatchObject({
      label: "User asserted",
      tone: "asserted",
    });
    expect(deliveryAuthorityPresentation("agent_claim")).toMatchObject({
      label: "Agent claim",
      tone: "claimed",
    });
    expect(deliveryAuthorityPresentation("legacy_unverified")).toMatchObject({
      label: "Legacy, unverified",
      tone: "unverified",
    });
    expect(deliveryAuthorityPresentation(null)).toMatchObject({
      label: "No evidence",
      tone: "empty",
    });
  });

  it("uses readable stage labels", () => {
    expect(deliveryStageLabel("functional_qa")).toBe("Functional QA");
    expect(deliveryStageLabel("technical_acceptance")).toBe("Technical Acceptance");
  });

  it("counts stale evidence without treating empty stages as stale", () => {
    const snapshot = {
      stages: {
        implementation: { eventId: "event-1", stale: false },
        ci: { eventId: "event-2", stale: true },
        deployment: { eventId: null, stale: true },
        smoke: { eventId: null, stale: false },
        functional_qa: { eventId: null, stale: false },
        technical_acceptance: { eventId: null, stale: false },
        business_acceptance: { eventId: null, stale: false },
      },
    } as unknown as DeliverySnapshotV1;

    expect(deliverySnapshotFreshness(snapshot)).toEqual({
      evidencedStageCount: 2,
      staleStageCount: 1,
      hasStaleEvidence: true,
    });
  });
});
