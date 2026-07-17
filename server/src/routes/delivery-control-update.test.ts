import { describe, expect, it } from "vitest";
import type { DeliverySnapshotV1 } from "@paperclipai/shared";
import { DELIVERY_STAGES } from "@paperclipai/shared";
import { renderDeliveryControlUpdate } from "./delivery.js";

function snapshot(): DeliverySnapshotV1 {
  const stages = Object.fromEntries(DELIVERY_STAGES.map((stage) => [stage, {
    stage,
    state: "unknown" as const,
    eventId: null,
    authority: null,
    candidateSha: "5fa761a27c7d8cfc285057e6997b04b9831a07c4",
    environment: "production",
    provider: null,
    providerExternalId: null,
    providerUrl: null,
    observedAt: null,
    stale: false,
    paperclipFactory: null,
  }])) as DeliverySnapshotV1["stages"];
  stages.ci = {
    ...stages.ci,
    state: "succeeded",
    authority: "provider_verified",
    provider: "github",
    providerExternalId: "29504462944",
    providerUrl: "https://github.com/example/repo/actions/runs/29504462944",
  };
  stages.deployment = {
    ...stages.deployment,
    state: "succeeded",
    authority: "provider_verified",
    provider: "cloudflare",
    providerExternalId: "2268dd54-02f6-4e86-b0cb-e93ae75b92ca",
  };
  return {
    version: 1,
    companyId: "11111111-1111-4111-8111-111111111111",
    issueId: "22222222-2222-4222-8222-222222222222",
    revision: `sha256:${"a".repeat(64)}`,
    watermark: { eventId: null, createdAt: null, eventCount: 2 },
    candidateSha: "5fa761a27c7d8cfc285057e6997b04b9831a07c4",
    environment: "production",
    stages,
    activeEventIds: [],
    supersededEventIds: [],
  };
}

describe("renderDeliveryControlUpdate", () => {
  it("renders authoritative facts from the snapshot and labels free text advisory", () => {
    const body = renderDeliveryControlUpdate(snapshot(), "I think the release looks good.");
    expect(body).toContain("Delivery status — authoritative snapshot");
    expect(body).toContain("| Ci | succeeded | provider_verified | github");
    expect(body).toContain("| Deployment | succeeded | provider_verified | cloudflare");
    expect(body).toContain(`Snapshot revision: \`sha256:${"a".repeat(64)}\``);
    expect(body).toContain("Note — advisory, not delivery evidence");
    expect(body).toContain("I think the release looks good.");
  });

  it("does not create an advisory section when no note is supplied", () => {
    expect(renderDeliveryControlUpdate(snapshot())).not.toContain("advisory");
  });
});
