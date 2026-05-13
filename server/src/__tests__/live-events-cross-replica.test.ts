import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
import { buildEnvelope, PG_NOTIFY_INLINE_LIMIT } from "../services/live-events/transport.js";

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

  it("falls back to ref-envelope + re-fetch for events that exceed the NOTIFY inline limit", async () => {
    // Build an event whose serialized envelope blows past PG_NOTIFY_INLINE_LIMIT.
    const big = "x".repeat(PG_NOTIFY_INLINE_LIMIT + 1000);
    const oversized = makeEvent({ id: 999, payload: { big } });
    const envelope = buildEnvelope("test-origin", oversized);
    expect(envelope.kind).toBe("ref");

    const fetcher = vi.fn(async (id: number) => {
      expect(id).toBe(999);
      return oversized;
    });

    const publisher = createPgLiveEventsTransport({ databaseUrl });
    const subscriber = createPgLiveEventsTransport({ databaseUrl, fetcher });
    const received: LiveEvent[] = [];
    subscriber.subscribe("company-a", (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 300));

    publisher.publish(oversized);

    const got = await waitFor(() => (received.length > 0 ? received[0] : undefined));
    expect(fetcher).toHaveBeenCalledWith(999);
    expect(got.id).toBe(999);
    // The receiver should observe the full event via the re-fetch, not
    // the truncated ref envelope.
    expect((got.payload as { big?: string }).big).toBe(big);

    await publisher.close();
    await subscriber.close();
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
