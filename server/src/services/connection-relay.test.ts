import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRelaySignature, type RelayEnvelope } from "@paperclip/connect-protocol";
import { processConnectionRelay, type ConnectionRelayStore } from "./connection-relay.js";

function fixture() {
  const envelope: RelayEnvelope = {
    v: 1,
    deliveryId: "dl_01K0EXAMPLE",
    connectionPublicRef: "cn_01K0EXAMPLE",
    providerSlug: "vercel",
    receivedAt: "2026-07-21T18:04:05.000Z",
    attempt: 1,
    provider: { headers: { "x-vercel-signature": "provider-signature" }, bodyB64: "eyJvayI6dHJ1ZX0=" },
    verification: { profile: "vercel@1", result: "verified", keyId: "primary" },
  };
  const rawBody = Buffer.from(JSON.stringify(envelope));
  const relaySecret = randomBytes(32);
  return { rawBody, relaySecret };
}

function store(): ConnectionRelayStore & { deliveries: Set<string> } {
  const deliveries = new Set<string>();
  return {
    deliveries,
    async findConnectionByPublicRef(publicRef) {
      return publicRef === "cn_01K0EXAMPLE" ? { id: "connection-1", companyId: "company-1", enabled: true } : null;
    },
    async createDeliveryIfAbsent({ envelope }) {
      if (deliveries.has(envelope.deliveryId)) return false;
      deliveries.add(envelope.deliveryId);
      return true;
    },
    async listEnabledTriggers() {
      return [{ id: "trigger-1", destinationType: "routine", destinationId: "routine-1" }];
    },
  };
}

describe("processConnectionRelay", () => {
  it("rejects a forged body before persistence or routing", async () => {
    const relayStore = store();
    const { rawBody, relaySecret } = fixture();
    const signature = createRelaySignature({ body: rawBody, relaySecret });
    const forgedBody = Buffer.from(rawBody.toString("utf8").replace("dl_01K0EXAMPLE", "dl_01K0FORGED0"));

    await expect(processConnectionRelay(relayStore, {
      rawBody: forgedBody,
      signature,
      timestamp: "1784657045",
      relaySecret,
      now: new Date("2026-07-21T18:04:05.000Z"),
    })).rejects.toMatchObject({ code: "invalid_relay_signature", status: 401 });
    expect(relayStore.deliveries.size).toBe(0);
  });

  it("persists once and drops replayed delivery ids", async () => {
    const relayStore = store();
    const { rawBody, relaySecret } = fixture();
    const input = {
      rawBody,
      signature: createRelaySignature({ body: rawBody, relaySecret }),
      timestamp: "1784657045",
      relaySecret,
      now: new Date("2026-07-21T18:04:05.000Z"),
    };

    await expect(processConnectionRelay(relayStore, input)).resolves.toMatchObject({
      status: "accepted",
      triggers: [{ destinationType: "routine", destinationId: "routine-1" }],
    });
    await expect(processConnectionRelay(relayStore, input)).resolves.toMatchObject({ status: "duplicate", triggers: [] });
    expect(relayStore.deliveries.size).toBe(1);
  });
});
