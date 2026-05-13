import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { createPgLiveEventsTransport } from "../services/live-events/pg-transport.js";
import { createRedisLiveEventsTransport } from "../services/live-events/redis-transport.js";
import {
  configureLiveEventsTransport,
  publishLiveEvent,
  subscribeCompanyLiveEvents,
  teardownLiveEventsTransport,
} from "../services/live-events.js";
import {
  buildEnvelope,
  OVERSIZED_EVENT,
  PG_NOTIFY_INLINE_LIMIT,
} from "../services/live-events/transport.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping cross-replica live-events tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function makeEvent(overrides: Partial<LiveEvent> = {}): LiveEvent {
  return {
    id: 1,
    companyId: "company-a",
    type: "activity.logged",
    createdAt: new Date().toISOString(),
    payload: {},
    ...overrides,
  };
}

async function waitFor<T>(fn: () => T | undefined, { timeoutMs = 5000, intervalMs = 25 } = {}): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined && value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timed out");
}

describeEmbeddedPostgres("live-events postgres LISTEN/NOTIFY transport", () => {
  let tempDb: EmbeddedPostgresTestDatabase | null = null;
  let databaseUrl = "";

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-live-events-");
    databaseUrl = tempDb.connectionString;
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("delivers a NOTIFY published on replica A to a LISTEN on replica B (different originIds)", async () => {
    const replicaA = createPgLiveEventsTransport({ databaseUrl });
    const replicaB = createPgLiveEventsTransport({ databaseUrl });
    expect(replicaA.originId).not.toBe(replicaB.originId);

    const receivedOnB: LiveEvent[] = [];
    replicaB.subscribe("company-a", (event) => receivedOnB.push(event));
    // Let LISTEN settle before publishing — postgres-js does it on a
    // dedicated socket and returns a meta handle asynchronously.
    await new Promise((r) => setTimeout(r, 300));

    const event = makeEvent({ id: 101, payload: { hello: "world" } });
    replicaA.publish(event);

    const got = await waitFor(() => (receivedOnB.length > 0 ? receivedOnB[0] : undefined));
    expect(got.id).toBe(101);
    expect(got.payload).toEqual({ hello: "world" });

    await replicaA.close();
    await replicaB.close();
  });

  it("drops self-echoes via originId filter (single replica subscribing to its own channel)", async () => {
    const replica = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    replica.subscribe("company-a", (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 300));

    replica.publish(makeEvent({ id: 202 }));
    // Give NOTIFY a chance to round-trip.
    await new Promise((r) => setTimeout(r, 500));

    // The same replica published it; the originId filter should drop it
    // so we don't double-emit (the local publishLiveEvent already
    // emitted the event in-process at the higher level).
    expect(received).toEqual([]);
    await replica.close();
  });

  it("isolates traffic across companies — a replica subscribed to A only never sees B's NOTIFY", async () => {
    const publisher = createPgLiveEventsTransport({ databaseUrl });
    const subscriberA = createPgLiveEventsTransport({ databaseUrl });
    const seenByA: LiveEvent[] = [];
    subscriberA.subscribe("company-a", (e) => seenByA.push(e));
    await new Promise((r) => setTimeout(r, 300));

    publisher.publish(makeEvent({ id: 301, companyId: "company-b", payload: { secret: "do-not-leak" } }));
    publisher.publish(makeEvent({ id: 302, companyId: "company-a" }));

    const got = await waitFor(() => (seenByA.length > 0 ? seenByA[0] : undefined));
    expect(got.id).toBe(302);
    expect(got.companyId).toBe("company-a");
    // Give B's NOTIFY a generous window to (incorrectly) arrive.
    await new Promise((r) => setTimeout(r, 500));
    expect(seenByA.some((e) => e.companyId === "company-b")).toBe(false);

    await publisher.close();
    await subscriberA.close();
  });

  it("drops oversized events symmetrically (no local emit, no cross-replica fan-out)", async () => {
    // Multibyte fixture: each "🦊" is 4 UTF-8 bytes but only 2 UTF-16 code
    // units. Picking a count that is comfortably under the limit when
    // measured as JS string length but blows past it when measured as
    // UTF-8 bytes — that's exactly the bug the byte-length check fixes.
    // PG_NOTIFY_INLINE_LIMIT is 7500. A count of 2500 fox emoji yields
    // ~10_000 UTF-8 bytes (definitely over), and the JSON envelope adds
    // another ~120 bytes for framing. JS string length would be 5000 —
    // well under 7500 — so the old `.length` check would have wrongly
    // emitted this event over the wire.
    const big = "🦊".repeat(2500);
    const oversized = makeEvent({ id: 999, payload: { big } });

    // Sanity-check the fixture really does exercise the byte-vs-char
    // distinction the check is guarding against.
    const serialized = JSON.stringify({ kind: "full", origin: "x", event: oversized });
    expect(serialized.length).toBeLessThan(PG_NOTIFY_INLINE_LIMIT);
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(PG_NOTIFY_INLINE_LIMIT);

    // Encoder must report the event as oversized.
    expect(buildEnvelope("test-origin", oversized)).toBe(OVERSIZED_EVENT);

    // End-to-end: publisher tries to publish, subscriber on another
    // replica must NOT see anything. The originating replica's local
    // emission is suppressed at the live-events service layer (verified
    // by the integration test below); here we verify the transport
    // itself does not put the bytes on the wire.
    const publisher = createPgLiveEventsTransport({ databaseUrl });
    const subscriber = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    subscriber.subscribe("company-a", (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 300));

    publisher.publish(oversized);
    // Generous window for NOTIFY to (incorrectly) round-trip.
    await new Promise((r) => setTimeout(r, 500));
    expect(received).toEqual([]);

    await publisher.close();
    await subscriber.close();
  });

  it("suppresses local emission for oversized events when a transport is configured (no cross-replica divergence)", async () => {
    await configureLiveEventsTransport({ mode: "postgres", databaseUrl });
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("company-a", (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 300));

    // Build a payload that crosses PG_NOTIFY_INLINE_LIMIT when measured
    // as UTF-8 bytes. Each "é" is 2 bytes UTF-8 but 1 JS char.
    const bigMultibyte = "é".repeat(PG_NOTIFY_INLINE_LIMIT);
    publishLiveEvent({
      companyId: "company-a",
      type: "activity.logged",
      payload: { big: bigMultibyte },
    });

    // The originating replica must NOT see the event locally either —
    // otherwise the originating replica diverges from peers that drop
    // it. Give the in-process emitter a tick to (incorrectly) fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([]);

    unsubscribe();
    await teardownLiveEventsTransport();
  });

  it("integrates with publishLiveEvent / subscribeCompanyLiveEvents through configureLiveEventsTransport", async () => {
    await configureLiveEventsTransport({ mode: "postgres", databaseUrl });
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("company-a", (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 300));

    // In a single-process test the in-process emitter delivers the
    // event immediately; the cross-replica path also fires through pg
    // but originId filter drops the echo. We just verify the in-process
    // delivery still works after the transport is installed.
    publishLiveEvent({ companyId: "company-a", type: "activity.logged" });
    expect(received).toHaveLength(1);

    unsubscribe();
    await teardownLiveEventsTransport();
  });
});

describe("live-events redis transport (mocked)", () => {
  // In-memory mock that mimics ioredis pub/sub semantics enough to
  // exercise the transport's lifecycle without a running Redis.
  function makeMockRedisFactory() {
    type Handler = (channel: string, message: string) => void;
    const subscribers = new Map<string, Set<{ subscribed: Set<string>; onMessage: Handler | null }>>();
    const allClients = new Set<{ subscribed: Set<string>; onMessage: Handler | null }>();

    function bind(channel: string, client: { subscribed: Set<string> }) {
      let set = subscribers.get(channel);
      if (!set) {
        set = new Set();
        subscribers.set(channel, set);
      }
      set.add(client as never);
    }
    function unbind(channel: string, client: { subscribed: Set<string> }) {
      const set = subscribers.get(channel);
      if (!set) return;
      set.delete(client as never);
      if (set.size === 0) subscribers.delete(channel);
    }

    return (_url: string) => {
      const subscribed = new Set<string>();
      const state: { subscribed: Set<string>; onMessage: Handler | null } = {
        subscribed,
        onMessage: null,
      };
      allClients.add(state);
      const baseClient = {
        on(event: string, cb: (...args: unknown[]) => void) {
          if (event === "message") {
            state.onMessage = (channel: string, message: string) =>
              cb(channel as unknown, message as unknown);
          }
        },
        async quit() {
          for (const ch of subscribed) unbind(ch, state);
          subscribed.clear();
          allClients.delete(state);
        },
      };
      const publisher = {
        ...baseClient,
        async publish(channel: string, message: string) {
          const set = subscribers.get(channel);
          if (!set) return 0;
          for (const sub of set) sub.onMessage?.(channel, message);
          return set.size;
        },
      };
      const subscriber = {
        ...baseClient,
        async subscribe(channel: string) {
          subscribed.add(channel);
          bind(channel, state);
        },
        async unsubscribe(channel: string) {
          subscribed.delete(channel);
          unbind(channel, state);
        },
      };
      return { publisher, subscriber };
    };
  }

  afterEach(async () => {
    await teardownLiveEventsTransport();
  });

  it("delivers cross-replica events via per-company channels and drops self-echoes", async () => {
    const factory = makeMockRedisFactory();
    const replicaA = createRedisLiveEventsTransport({
      redisUrl: "redis://test",
      clientFactory: factory,
    });
    const replicaB = createRedisLiveEventsTransport({
      redisUrl: "redis://test",
      clientFactory: factory,
    });

    const seenByB: LiveEvent[] = [];
    replicaB.subscribe("company-a", (e) => seenByB.push(e));
    // Mock factory is async — wait for init.
    await new Promise((r) => setTimeout(r, 20));

    replicaA.publish(makeEvent({ id: 401 }));
    await waitFor(() => (seenByB.length > 0 ? seenByB[0] : undefined), { timeoutMs: 1000 });
    expect(seenByB[0]?.id).toBe(401);

    // Self-echo: replicaA also subscribed to its own publish? Try it.
    const seenByA: LiveEvent[] = [];
    replicaA.subscribe("company-a", (e) => seenByA.push(e));
    await new Promise((r) => setTimeout(r, 20));
    replicaA.publish(makeEvent({ id: 402 }));
    await new Promise((r) => setTimeout(r, 50));
    // origin filter should suppress replicaA's own publish
    expect(seenByA.map((e) => e.id)).not.toContain(402);
    // But replicaB still gets it
    await waitFor(() => seenByB.find((e) => e.id === 402));

    await replicaA.close();
    await replicaB.close();
  });

  it("isolates traffic across companies (replica subscribed to A doesn't see B)", async () => {
    const factory = makeMockRedisFactory();
    const publisher = createRedisLiveEventsTransport({ redisUrl: "redis://test", clientFactory: factory });
    const subscriberA = createRedisLiveEventsTransport({ redisUrl: "redis://test", clientFactory: factory });
    const seenByA: LiveEvent[] = [];
    subscriberA.subscribe("company-a", (e) => seenByA.push(e));
    await new Promise((r) => setTimeout(r, 20));

    publisher.publish(makeEvent({ id: 501, companyId: "company-b" }));
    publisher.publish(makeEvent({ id: 502, companyId: "company-a" }));

    await waitFor(() => seenByA.find((e) => e.id === 502), { timeoutMs: 1000 });
    await new Promise((r) => setTimeout(r, 50));
    expect(seenByA.some((e) => e.companyId === "company-b")).toBe(false);

    await publisher.close();
    await subscriberA.close();
  });
});

describe("live-events transport=off", () => {
  afterEach(async () => {
    await teardownLiveEventsTransport();
  });

  it("publishes in-process events without attempting cross-replica fan-out", async () => {
    await configureLiveEventsTransport({ mode: "off" });
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("company-a", (e) => received.push(e));
    publishLiveEvent({ companyId: "company-a", type: "activity.logged" });
    expect(received).toHaveLength(1);
    unsubscribe();
  });
});
