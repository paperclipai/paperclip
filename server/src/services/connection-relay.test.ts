import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createRelaySignature, type RelayEnvelope } from "@paperclip/connect-protocol";
import { pollRelayChannel, processAndDispatchConnectionRelay, processConnectionRelay, type ConnectionRelayStore } from "./connection-relay.js";

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

function store(): ConnectionRelayStore & { deliveries: Set<string>; statuses: string[] } {
  const deliveries = new Set<string>();
  const statuses: string[] = [];
  return {
    deliveries,
    statuses,
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
    async updateDelivery({ status }) {
      statuses.push(status);
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
    })).rejects.toMatchObject({ code: "invalid_envelope", status: 401 });
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

  it("dispatches a routine and records observable status transitions", async () => {
    const relayStore = store();
    const { rawBody, relaySecret } = fixture();
    const fired: string[] = [];
    const result = await processAndDispatchConnectionRelay(relayStore, {
      routine: async (trigger) => { fired.push(trigger.destinationId); },
      issue_wake: async () => {},
      plugin_worker: async () => {},
    }, {
      rawBody,
      signature: createRelaySignature({ body: rawBody, relaySecret }),
      timestamp: "1784657045",
      relaySecret,
      now: new Date("2026-07-21T18:04:05.000Z"),
    });

    expect(result.status).toBe("delivered");
    expect(fired).toEqual(["routine-1"]);
    expect(relayStore.deliveries).toEqual(new Set(["dl_01K0EXAMPLE"]));
    expect(relayStore.statuses).toEqual(["forwarded", "delivered"]);
  });

  it("records a dead letter after the final failed attempt", async () => {
    const relayStore = store();
    const { rawBody: originalBody, relaySecret } = fixture();
    const envelope = { ...JSON.parse(originalBody.toString("utf8")), attempt: 10 };
    const rawBody = Buffer.from(JSON.stringify(envelope));
    const result = await processAndDispatchConnectionRelay(relayStore, {
      routine: async () => { throw new Error("routine unavailable"); },
      issue_wake: async () => {},
      plugin_worker: async () => {},
    }, {
      rawBody,
      signature: createRelaySignature({ body: rawBody, relaySecret }),
      timestamp: "1784657045",
      relaySecret,
      now: new Date("2026-07-21T18:04:05.000Z"),
    });
    expect(result.status).toBe("dead_letter");
    expect(relayStore.statuses).toEqual(["forwarded", "dead_letter"]);
  });

  it("falls back to long-poll and forwards channel envelopes", async () => {
    const { rawBody } = fixture();
    const envelope = JSON.parse(rawBody.toString("utf8"));
    const calls: string[] = [];
    const received: string[] = [];
    await pollRelayChannel({
      baseUrl: "https://connect.example",
      createSession: async () => "short-lived-token",
      fetch: async (url) => {
        calls.push(String(url));
        return calls.length === 1
          ? new Response(null, { status: 503 })
          : Response.json([{ envelope, signature: "sha256=test", timestamp: "1784657045" }]);
      },
      onEnvelope: async ({ body }) => { received.push(JSON.parse(body.toString("utf8")).deliveryId); },
    });
    expect(calls.map((url) => new URL(url).pathname)).toEqual(["/v1/relay/channel", "/v1/relay/poll"]);
    expect(received).toEqual(["dl_01K0EXAMPLE"]);
  });
});
