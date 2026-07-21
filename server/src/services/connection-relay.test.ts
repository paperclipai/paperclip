import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelaySignature, type RelayEnvelope } from "@paperclip/connect-protocol";
import { companies, connectionTriggerDeliveries, connectionTriggers, createDb, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { connectionRelayStore, pollRelayChannel, processAndDispatchConnectionRelay, processConnectionRelay, type ConnectionRelayStore } from "./connection-relay.js";

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

function store(): ConnectionRelayStore & { deliveries: Set<string>; statuses: string[]; completedTriggerIds: Set<string> } {
  const deliveries = new Set<string>();
  const statuses: string[] = [];
  const completedTriggerIds = new Set<string>();
  return {
    deliveries,
    statuses,
    completedTriggerIds,
    async findConnectionByPublicRef(publicRef) {
      return publicRef === "cn_01K0EXAMPLE" ? { id: "connection-1", companyId: "company-1", enabled: true } : null;
    },
    async claimDelivery({ envelope }) {
      if (deliveries.has(envelope.deliveryId)) return { claimed: false, completedTriggerIds: [] };
      deliveries.add(envelope.deliveryId);
      return { claimed: true, completedTriggerIds: [...completedTriggerIds] };
    },
    async listEnabledTriggers() {
      return [{ id: "trigger-1", companyId: "company-1", destinationType: "routine", destinationId: "routine-1" }];
    },
    async updateDelivery({ status }) {
      statuses.push(status);
    },
    async markTriggerCompleted({ triggerId }) {
      completedTriggerIds.add(triggerId);
    },
  };
}

describe("processConnectionRelay", () => {
  it("rejects a forged body before persistence or routing", async () => {
    const relayStore = store();
    const { rawBody, relaySecret } = fixture();
    const signature = createRelaySignature({ body: rawBody, relaySecret, timestamp: "1784657045" });
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
      signature: createRelaySignature({ body: rawBody, relaySecret, timestamp: "1784657045" }),
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
      signature: createRelaySignature({ body: rawBody, relaySecret, timestamp: "1784657045" }),
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
      signature: createRelaySignature({ body: rawBody, relaySecret, timestamp: "1784657045" }),
      timestamp: "1784657045",
      relaySecret,
      now: new Date("2026-07-21T18:04:05.000Z"),
    });
    expect(result.status).toBe("dead_letter");
    expect(relayStore.statuses).toEqual(["forwarded", "dead_letter"]);
  });

  it("reclaims only a higher failed attempt and resumes after completed triggers", async () => {
    const { rawBody: firstBody, relaySecret } = fixture();
    let attempt = 0;
    let status = "received";
    const completed = new Set<string>();
    const retryStore: ConnectionRelayStore = {
      async findConnectionByPublicRef() { return { id: "connection-1", companyId: "company-1", enabled: true }; },
      async claimDelivery({ envelope }) {
        if (attempt === 0 || (status === "failed" && envelope.attempt > attempt)) {
          attempt = envelope.attempt;
          status = "received";
          return { claimed: true, completedTriggerIds: [...completed] };
        }
        return { claimed: false, completedTriggerIds: [] };
      },
      async listEnabledTriggers() {
        return [
          { id: "trigger-1", companyId: "company-1", destinationType: "routine", destinationId: "routine-1" },
          { id: "trigger-2", companyId: "company-1", destinationType: "routine", destinationId: "routine-2" },
        ];
      },
      async updateDelivery(input) { status = input.status; },
      async markTriggerCompleted({ triggerId }) { completed.add(triggerId); },
    };
    const fired: string[] = [];
    const dispatcher = {
      routine: async (trigger: { destinationId: string }) => {
        fired.push(trigger.destinationId);
        if (trigger.destinationId === "routine-2" && attempt === 1) throw new Error("temporary failure");
      },
      issue_wake: async () => {},
      plugin_worker: async () => {},
    };
    const firstInput = { rawBody: firstBody, signature: createRelaySignature({ body: firstBody, relaySecret, timestamp: "1784657045" }), timestamp: "1784657045", relaySecret, now: new Date("2026-07-21T18:04:05.000Z") };
    await expect(processAndDispatchConnectionRelay(retryStore, dispatcher, firstInput)).resolves.toMatchObject({ status: "failed" });
    await expect(processAndDispatchConnectionRelay(retryStore, dispatcher, firstInput)).resolves.toMatchObject({ status: "duplicate" });

    const secondEnvelope = { ...JSON.parse(firstBody.toString("utf8")), attempt: 2 };
    const secondBody = Buffer.from(JSON.stringify(secondEnvelope));
    await expect(processAndDispatchConnectionRelay(retryStore, dispatcher, { ...firstInput, rawBody: secondBody, signature: createRelaySignature({ body: secondBody, relaySecret, timestamp: "1784657045" }) })).resolves.toMatchObject({ status: "delivered" });
    expect(fired).toEqual(["routine-1", "routine-2", "routine-2"]);
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
    expect(calls.map((url) => new URL(url).pathname)).toEqual(["/v1/relay/stream", "/v1/relay/poll"]);
    expect(received).toEqual(["dl_01K0EXAMPLE"]);
  });

  it("consumes SSE data and acknowledges successful deliveries", async () => {
    const { rawBody } = fixture();
    const envelope = JSON.parse(rawBody.toString("utf8"));
    const acknowledged: string[][] = [];
    const received: string[] = [];
    await pollRelayChannel({
      baseUrl: "https://connect.example",
      createSession: async () => ({ channelToken: "short-lived-token", streamUrl: "/v1/relay/stream" }),
      fetch: async () => new Response(`id: ${envelope.deliveryId}\ndata: ${JSON.stringify({ envelope, signature: "v1=test", timestamp: "1784657045" })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
      onEnvelope: async ({ body }) => { received.push(JSON.parse(body.toString("utf8")).deliveryId); },
      acknowledge: async (deliveryIds) => { acknowledged.push(deliveryIds); },
    });
    expect(received).toEqual(["dl_01K0EXAMPLE"]);
    expect(acknowledged).toEqual([["dl_01K0EXAMPLE"]]);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("connection relay persistence", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-connection-relay-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("persists an observable delivery row and fires one routine destination", async () => {
    const company = await db.insert(companies).values({ name: "Relay Test", issuePrefix: "RLY" }).returning().then((rows) => rows[0]!);
    const application = await db.insert(toolApplications).values({ companyId: company.id, name: "Vercel", type: "mcp_http" }).returning().then((rows) => rows[0]!);
    const connection = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Vercel Relay",
      uid: "vercel-relay",
      transport: "rest_api",
      enabled: true,
      config: { relay: { publicRef: "cn_01K0EXAMPLE" } },
    }).returning().then((rows) => rows[0]!);
    await db.insert(connectionTriggers).values({
      companyId: company.id,
      connectionId: connection.id,
      destinationType: "routine",
      destinationId: "11111111-1111-4111-8111-111111111111",
    });

    const { rawBody, relaySecret } = fixture();
    const fired: string[] = [];
    const result = await processAndDispatchConnectionRelay(connectionRelayStore(db), {
      routine: async (trigger) => { fired.push(trigger.destinationId); },
      issue_wake: async () => {},
      plugin_worker: async () => {},
    }, {
      rawBody,
      signature: createRelaySignature({ body: rawBody, relaySecret, timestamp: "1784657045" }),
      timestamp: "1784657045",
      relaySecret,
      now: new Date("2026-07-21T18:04:05.000Z"),
    });

    const rows = await db.select().from(connectionTriggerDeliveries);
    expect(result.status).toBe("delivered");
    expect(fired).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deliveryId: "dl_01K0EXAMPLE", status: "delivered", connectionId: connection.id });
  });
});
