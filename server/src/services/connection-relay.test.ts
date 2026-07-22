import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRelaySignature, type RelayEnvelope } from "@paperclipai/connect-protocol";
import { agentWakeupRequests, agents, companies, connectionTriggerDeliveries, connectionTriggers, createDb, issues, toolApplications, toolConnections } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { connectionRelayDispatcher, connectionRelayStore, pollRelayChannel, processAndDispatchConnectionRelay, processConnectionRelay, RELAY_DELIVERY_LEASE_MS, type ConnectionRelayStore, type RelayTrigger } from "./connection-relay.js";

function fixture(overrides: Partial<RelayEnvelope> = {}) {
  const envelope: RelayEnvelope = {
    v: 1,
    deliveryId: "dl_01K0EXAMPLE",
    connectionPublicRef: "cn_01K0EXAMPLE",
    providerSlug: "vercel",
    receivedAt: "2026-07-21T18:04:05.000Z",
    attempt: 1,
    provider: { headers: { "x-vercel-signature": "provider-signature" }, bodyB64: "eyJvayI6dHJ1ZX0=" },
    verification: { profile: "vercel@1", result: "verified", keyId: "primary" },
    ...overrides,
  };
  const rawBody = Buffer.from(JSON.stringify(envelope));
  const relaySecret = randomBytes(32);
  return { rawBody, relaySecret };
}

function store(): ConnectionRelayStore & { deliveries: Set<string>; statuses: string[]; completedTriggerIds: Set<string> } {
  const deliveries = new Set<string>();
  const snapshots = new Map<string, RelayTrigger[]>();
  const statuses: string[] = [];
  const completedTriggerIds = new Set<string>();
  return {
    deliveries,
    statuses,
    completedTriggerIds,
    async findConnectionByPublicRef(publicRef) {
      return publicRef === "cn_01K0EXAMPLE" ? { id: "connection-1", companyId: "company-1", enabled: true } : null;
    },
    async claimDelivery({ envelope, triggerSnapshot }) {
      // Mirror the store: the snapshot is captured once, on the first claim, and reused thereafter.
      if (deliveries.has(envelope.deliveryId)) return { claimed: false, completedTriggerIds: [], triggerSnapshot: snapshots.get(envelope.deliveryId) ?? null };
      deliveries.add(envelope.deliveryId);
      snapshots.set(envelope.deliveryId, triggerSnapshot);
      return { claimed: true, completedTriggerIds: [...completedTriggerIds], triggerSnapshot };
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

  it("reuses the same destination idempotency key after an incomplete handoff", async () => {
    const { rawBody, relaySecret } = fixture();
    const envelope = JSON.parse(rawBody.toString("utf8")) as RelayEnvelope;
    let markAttempts = 0;
    const retryStore: ConnectionRelayStore = {
      async findConnectionByPublicRef() {
        return { id: "connection-1", companyId: "company-1", enabled: true };
      },
      async claimDelivery({ triggerSnapshot }) {
        return { claimed: true, completedTriggerIds: [], triggerSnapshot };
      },
      async listEnabledTriggers() {
        return [{ id: "trigger-1", companyId: "company-1", destinationType: "routine", destinationId: "routine-1" }];
      },
      async updateDelivery() {},
      async markTriggerCompleted() {
        markAttempts += 1;
        if (markAttempts === 1) throw new Error("simulated crash before progress persistence");
      },
    };
    const idempotencyKeys: string[] = [];
    const dispatcher = {
      routine: async (_trigger: RelayTrigger, _envelope: RelayEnvelope, context: { idempotencyKey: string }) => {
        idempotencyKeys.push(context.idempotencyKey);
      },
      issue_wake: async () => {},
      plugin_worker: async () => {},
    };
    const input = {
      rawBody,
      signature: createRelaySignature({ body: rawBody, relaySecret, timestamp: "1784657045" }),
      timestamp: "1784657045",
      relaySecret,
      now: new Date("2026-07-21T18:04:05.000Z"),
    };

    await expect(processAndDispatchConnectionRelay(retryStore, dispatcher, input)).resolves.toMatchObject({ status: "failed" });
    const retryBody = Buffer.from(JSON.stringify({ ...envelope, attempt: 2 }));
    await expect(processAndDispatchConnectionRelay(retryStore, dispatcher, {
      ...input,
      rawBody: retryBody,
      signature: createRelaySignature({ body: retryBody, relaySecret, timestamp: "1784657045" }),
    })).resolves.toMatchObject({ status: "delivered" });
    expect(idempotencyKeys).toEqual([
      "connection-relay:dl_01K0EXAMPLE:trigger-1",
      "connection-relay:dl_01K0EXAMPLE:trigger-1",
    ]);
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
    let snapshot: RelayTrigger[] | null = null;
    const completed = new Set<string>();
    const retryStore: ConnectionRelayStore = {
      async findConnectionByPublicRef() { return { id: "connection-1", companyId: "company-1", enabled: true }; },
      async claimDelivery({ envelope, triggerSnapshot }) {
        if (attempt === 0 || (status === "failed" && envelope.attempt > attempt)) {
          if (snapshot === null) snapshot = triggerSnapshot;
          attempt = envelope.attempt;
          status = "received";
          return { claimed: true, completedTriggerIds: [...completed], triggerSnapshot: snapshot };
        }
        return { claimed: false, completedTriggerIds: [], triggerSnapshot: snapshot };
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

  it("deduplicates an accepted issue wake when relay progress was not persisted", async () => {
    const company = await db.insert(companies).values({ name: "Relay Wake", issuePrefix: "RLW" }).returning().then((rows) => rows[0]!);
    const agent = await db.insert(agents).values({
      companyId: company.id,
      name: "Paused Relay Agent",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning().then((rows) => rows[0]!);
    const issue = await db.insert(issues).values({
      companyId: company.id,
      title: "Relay wake target",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agent.id,
    }).returning().then((rows) => rows[0]!);
    const trigger: RelayTrigger = {
      id: "55555555-5555-4555-8555-555555555555",
      companyId: company.id,
      destinationType: "issue_wake",
      destinationId: issue.id,
    };
    const envelope = JSON.parse(fixture().rawBody.toString("utf8")) as RelayEnvelope;
    const dispatcher = connectionRelayDispatcher(db, {
      heartbeat: {
        wakeup: async (agentId, options) => {
          await db.insert(agentWakeupRequests).values({
            companyId: company.id,
            agentId,
            source: options?.source ?? "automation",
            triggerDetail: options?.triggerDetail ?? null,
            reason: options?.reason ?? null,
            status: "queued",
            idempotencyKey: options?.idempotencyKey ?? null,
          });
          return null;
        },
      },
    });
    const context = { idempotencyKey: `connection-relay:${envelope.deliveryId}:${trigger.id}` };

    await dispatcher.issue_wake(trigger, envelope, context);
    await dispatcher.issue_wake(trigger, envelope, context);

    const wakeups = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.idempotencyKey, context.idempotencyKey));
    expect(wakeups).toHaveLength(1);
  });

  it("routes retries to the trigger set captured on the first attempt, not newly enabled triggers", async () => {
    const company = await db.insert(companies).values({ name: "Relay Snapshot", issuePrefix: "RLS" }).returning().then((rows) => rows[0]!);
    const application = await db.insert(toolApplications).values({ companyId: company.id, name: "Vercel", type: "mcp_http" }).returning().then((rows) => rows[0]!);
    const connection = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Vercel Relay",
      uid: "vercel-relay-snapshot",
      transport: "rest_api",
      enabled: true,
      config: { relay: { publicRef: "cn_01K0SNAPSHOT" } },
    }).returning().then((rows) => rows[0]!);
    const originalDestination = "11111111-1111-4111-8111-111111111111";
    const lateDestination = "22222222-2222-4222-8222-222222222222";
    await db.insert(connectionTriggers).values({ companyId: company.id, connectionId: connection.id, destinationType: "routine", destinationId: originalDestination });

    const { rawBody: firstBody, relaySecret } = fixture({ connectionPublicRef: "cn_01K0SNAPSHOT", deliveryId: "dl_01K0SNAPSHOT" });
    const now = new Date("2026-07-21T18:04:05.000Z");
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const store = connectionRelayStore(db);
    const fired: string[] = [];
    const dispatcher = {
      routine: async (trigger: { destinationId: string }) => {
        fired.push(trigger.destinationId);
        // Fail the very first dispatch so the delivery is retried; succeed on the retry.
        if (trigger.destinationId === originalDestination && fired.filter((id) => id === originalDestination).length === 1) throw new Error("temporary failure");
      },
      issue_wake: async () => {},
      plugin_worker: async () => {},
    };

    const first = await processAndDispatchConnectionRelay(store, dispatcher, {
      rawBody: firstBody,
      signature: createRelaySignature({ body: firstBody, relaySecret, timestamp }),
      timestamp,
      relaySecret,
      now,
    });
    expect(first.status).toBe("failed");

    // Operator enables a brand-new trigger after the envelope was already captured.
    await db.insert(connectionTriggers).values({ companyId: company.id, connectionId: connection.id, destinationType: "routine", destinationId: lateDestination });

    const secondEnvelope = { ...JSON.parse(firstBody.toString("utf8")), attempt: 2 };
    const secondBody = Buffer.from(JSON.stringify(secondEnvelope));
    const second = await processAndDispatchConnectionRelay(store, dispatcher, {
      rawBody: secondBody,
      signature: createRelaySignature({ body: secondBody, relaySecret, timestamp }),
      timestamp,
      relaySecret,
      now,
    });

    expect(second.status).toBe("delivered");
    // The late trigger never receives the pre-existing envelope; only the snapshotted destination fires.
    expect(fired).toEqual([originalDestination, originalDestination]);
    const rows = await db.select().from(connectionTriggerDeliveries).where(eq(connectionTriggerDeliveries.connectionId, connection.id));
    expect(rows).toHaveLength(1);
    expect((rows[0]!.triggerSnapshot ?? []).map((trigger) => trigger.destinationId)).toEqual([originalDestination]);
  });

  it("reclaims an abandoned forwarded delivery only after its lease expires", async () => {
    const company = await db.insert(companies).values({ name: "Relay Lease", issuePrefix: "RLL" }).returning().then((rows) => rows[0]!);
    const application = await db.insert(toolApplications).values({ companyId: company.id, name: "Vercel", type: "mcp_http" }).returning().then((rows) => rows[0]!);
    const connection = await db.insert(toolConnections).values({
      companyId: company.id,
      applicationId: application.id,
      name: "Vercel Relay",
      uid: "vercel-relay-lease",
      transport: "rest_api",
      enabled: true,
      config: { relay: { publicRef: "cn_01K0LEASE" } },
    }).returning().then((rows) => rows[0]!);
    const destination = "33333333-3333-4333-8333-333333333333";
    await db.insert(connectionTriggers).values({ companyId: company.id, connectionId: connection.id, destinationType: "routine", destinationId: destination });

    const { rawBody, relaySecret } = fixture({ connectionPublicRef: "cn_01K0LEASE", deliveryId: "dl_01K0LEASE" });
    const envelope = JSON.parse(rawBody.toString("utf8")) as RelayEnvelope;
    const store = connectionRelayStore(db);

    // A worker claims the delivery and marks it `forwarded`, then crashes before dispatching.
    const claimedAt = new Date("2026-07-21T18:04:05.000Z");
    const capturedTriggers = await store.listEnabledTriggers(connection.id);
    await store.claimDelivery({ companyId: company.id, connectionId: connection.id, envelope, triggerSnapshot: capturedTriggers, now: claimedAt });
    await store.updateDelivery!({ connectionId: connection.id, deliveryId: envelope.deliveryId, status: "forwarded", now: claimedAt });

    const dispatchAt = async (now: Date) => {
      const timestamp = String(Math.floor(now.getTime() / 1000));
      const fired: string[] = [];
      const result = await processAndDispatchConnectionRelay(store, {
        routine: async (trigger) => { fired.push(trigger.destinationId); },
        issue_wake: async () => {},
        plugin_worker: async () => {},
      }, { rawBody, signature: createRelaySignature({ body: rawBody, relaySecret, timestamp }), timestamp, relaySecret, now });
      return { result, fired };
    };

    // While the lease is still live the row must not be reclaimed — an active worker could still
    // be running, so a competing attempt is dropped as a duplicate and nothing is dispatched.
    const duringLease = await dispatchAt(new Date(claimedAt.getTime() + RELAY_DELIVERY_LEASE_MS / 2));
    expect(duringLease.result.status).toBe("duplicate");
    expect(duringLease.fired).toEqual([]);

    // A trigger enabled after the crash must not receive this in-flight envelope: recovery reuses
    // the snapshot captured with the claim, never the connection's current trigger configuration.
    await db.insert(connectionTriggers).values({ companyId: company.id, connectionId: connection.id, destinationType: "routine", destinationId: "44444444-4444-4444-8444-444444444444" });

    // Once the lease has expired the abandoned delivery is safely reclaimed and the work runs.
    const afterLease = await dispatchAt(new Date(claimedAt.getTime() + RELAY_DELIVERY_LEASE_MS + 60_000));
    expect(afterLease.result.status).toBe("delivered");
    expect(afterLease.fired).toEqual([destination]);

    const rows = await db.select().from(connectionTriggerDeliveries).where(eq(connectionTriggerDeliveries.connectionId, connection.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("delivered");
    expect((rows[0]!.triggerSnapshot ?? []).map((trigger) => trigger.destinationId)).toEqual([destination]);
  });
});
