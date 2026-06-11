import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { postgres } from "@paperclipai/db";
import type { LiveEvent } from "@paperclipai/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pgChannelForCompany, redisChannelForCompany } from "../services/live-events/channel.js";
import { createPgLiveEventsTransport } from "../services/live-events/pg-transport.js";
import { createRedisLiveEventsTransport } from "../services/live-events/redis-transport.js";
import {
  configureLiveEventsTransport,
  publishLiveEvent,
  subscribeCompanyLiveEvents,
  teardownLiveEventsTransport,
  whenTransportSubscribed,
} from "../services/live-events.js";

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
    // Wait for LISTEN to settle before publishing — postgres-js does it on
    // a dedicated socket and returns a meta handle asynchronously.
    await replicaB.whenSubscribed!("company-a");

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
    await replica.whenSubscribed!("company-a");

    replica.publish(makeEvent({ id: 202 }));
    // Negative assertion: there is no readiness signal for "the echo would
    // have arrived by now", so give NOTIFY a generous round-trip window.
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
    await subscriberA.whenSubscribed!("company-a");

    publisher.publish(makeEvent({ id: 301, companyId: "company-b", payload: { secret: "do-not-leak" } }));
    publisher.publish(makeEvent({ id: 302, companyId: "company-a" }));

    const got = await waitFor(() => (seenByA.length > 0 ? seenByA[0] : undefined));
    expect(got.id).toBe(302);
    expect(got.companyId).toBe("company-a");
    // Negative assertion with no readiness signal: give B's NOTIFY a
    // generous window to (incorrectly) arrive.
    await new Promise((r) => setTimeout(r, 500));
    expect(seenByA.some((e) => e.companyId === "company-b")).toBe(false);

    await publisher.close();
    await subscriberA.close();
  });

  it("integrates with publishLiveEvent / subscribeCompanyLiveEvents through configureLiveEventsTransport", async () => {
    await configureLiveEventsTransport({ mode: "postgres", databaseUrl });
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("company-a", (e) => received.push(e));
    await whenTransportSubscribed("company-a");

    // In a single-process test the in-process emitter delivers the
    // event immediately; the cross-replica path also fires through pg
    // but originId filter drops the echo. We just verify the in-process
    // delivery still works after the transport is installed.
    publishLiveEvent({ companyId: "company-a", type: "activity.logged" });
    expect(received).toHaveLength(1);

    unsubscribe();
    await teardownLiveEventsTransport();
  });

  it("rebinds subscribers that attached before configureLiveEventsTransport (boot race)", async () => {
    // Reproduces the boot race that greptile flagged: a WS handler
    // subscribes during server startup while configureLiveEventsTransport
    // is still resolving. Before the fix, attachTransportFor short-
    // circuited on `!transport` and never recorded the subscriber, so
    // rebindExistingSubscriptions later iterated an empty map and the
    // subscriber missed cross-replica events for its lifetime.
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("company-a", (e) => received.push(e));

    // Configure the transport AFTER the subscription is already in place.
    await configureLiveEventsTransport({ mode: "postgres", databaseUrl });
    // LISTEN is async; wait for postgres-js to settle it.
    await whenTransportSubscribed("company-a");

    // Publish from an independent replica so the in-process path is not
    // involved — delivery must come exclusively through LISTEN/NOTIFY.
    const replicaA = createPgLiveEventsTransport({ databaseUrl });
    replicaA.publish(makeEvent({ id: 9001, payload: { boot: "race" } }));

    const got = await waitFor(() => received.find((e) => e.id === 9001));
    expect(got.id).toBe(9001);
    expect(got.payload).toEqual({ boot: "race" });

    unsubscribe();
    await replicaA.close();
    await teardownLiveEventsTransport();
  });

  it("coalesces a burst into batch envelopes and delivers all events", async () => {
    const sender = createPgLiveEventsTransport({ databaseUrl });
    const receiver = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    receiver.subscribe("company-a", (event) => received.push(event));
    await receiver.whenSubscribed!("company-a");

    // Raw frame observer: a plain postgres-js LISTEN on the same channel
    // records the wire envelopes, so we can assert the burst actually
    // coalesced into fewer frames rather than 20 one-event NOTIFYs.
    const rawSql = postgres(databaseUrl, { max: 1 });
    const frames: { kind?: string }[] = [];
    await rawSql.listen(pgChannelForCompany("company-a"), (raw) => frames.push(JSON.parse(raw)));

    for (let i = 1; i <= 20; i++) sender.publish(makeEvent({ id: i }));
    await waitFor(() => (received.length === 20 ? received : undefined));
    expect(received.map((e) => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));

    // The raw listener is a separate connection; wait until it has seen a
    // batch frame before asserting on counts.
    await waitFor(() => (frames.some((f) => f.kind === "batch") ? true : undefined));
    expect(frames.length).toBeLessThan(20);

    await rawSql.end({ timeout: 5 });
    await sender.close();
    await receiver.close();
  });

  it("survives a malformed NOTIFY envelope and keeps the LISTEN connection alive", async () => {
    const receiver = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    receiver.subscribe("company-a", (event) => received.push(event));
    await receiver.whenSubscribed!("company-a");

    // Inject valid JSON with an unknown kind straight onto the channel.
    // Before envelopeToEvents was total, this returned undefined and the
    // resulting `for ... of undefined` TypeError propagated into
    // postgres-js's onnotify dispatch, killing the LISTEN connection.
    const rawSql = postgres(databaseUrl, { max: 1 });
    await rawSql.notify(
      pgChannelForCompany("company-a"),
      JSON.stringify({ origin: "other", kind: "bogus" }),
    );

    // A well-formed event published afterwards must still arrive — that
    // proves the malformed frame was dropped and the LISTEN survived.
    const sender = createPgLiveEventsTransport({ databaseUrl });
    sender.publish(makeEvent({ id: 707 }));
    const got = await waitFor(() => received.find((e) => e.id === 707));
    expect(got.id).toBe(707);
    // Nothing was delivered for the bogus frame (and no synthetic resync
    // from a reconnect either — the connection never dropped).
    expect(received.map((e) => e.id)).toEqual([707]);

    await rawSql.end({ timeout: 5 });
    await sender.close();
    await receiver.close();
  });

  it("delivers a resync marker for an oversized event instead of dropping it", async () => {
    const sender = createPgLiveEventsTransport({ databaseUrl });
    const receiver = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    receiver.subscribe("company-a", (event) => received.push(event));
    await receiver.whenSubscribed!("company-a");
    sender.publish(makeEvent({ type: "heartbeat.run.log", payload: { huge: "x".repeat(10_000) } }));
    const marker = await waitFor(() => received[0]);
    expect(marker.type).toBe("heartbeat.run.log");
    expect(marker.payload).toEqual({ __resync: true });
    await sender.close();
    await receiver.close();
  });

  it("does not duplicate delivery after unsubscribe→resubscribe while LISTEN is in flight", async () => {
    const receiver = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    const handler = (e: LiveEvent) => received.push(e);
    // All three calls land within one LISTEN round-trip: the first LISTEN
    // is still in flight when its subscription record is deleted and a new
    // one is seated. Without the identity guard, listen #1's callback
    // stayed registered forever and every NOTIFY was delivered twice.
    receiver.subscribe("company-a", handler);
    receiver.unsubscribe("company-a", handler);
    receiver.subscribe("company-a", handler);
    await receiver.whenSubscribed!("company-a");

    const sender = createPgLiveEventsTransport({ databaseUrl });
    sender.publish(makeEvent({ id: 808 }));
    await waitFor(() => received.find((e) => e.id === 808));
    // Negative assertion (no signal for "the duplicate would have arrived
    // by now"): both callbacks fire from the same NOTIFY dispatch, so a
    // short settle is enough for the duplicate to show up if it exists.
    await new Promise((r) => setTimeout(r, 200));
    expect(received.map((e) => e.id)).toEqual([808]);

    await sender.close();
    await receiver.close();
  });

  it("close() flushes pending coalesced events", async () => {
    const sender = createPgLiveEventsTransport({ databaseUrl });
    const receiver = createPgLiveEventsTransport({ databaseUrl });
    const received: LiveEvent[] = [];
    receiver.subscribe("company-a", (event) => received.push(event));
    await receiver.whenSubscribed!("company-a");
    sender.publish(makeEvent({ id: 42 }));
    await sender.close(); // before the 25ms window elapses
    const event = await waitFor(() => received[0]);
    expect(event.id).toBe(42);
    await receiver.close();
  });

  it("reports notification queue usage via stats()", async () => {
    const transport = createPgLiveEventsTransport({ databaseUrl });
    const stats = await transport.stats!();
    expect(stats.notificationQueueUsage).toBeGreaterThanOrEqual(0);
    expect(stats.notificationQueueUsage).toBeLessThan(1);
    await transport.close();
  });

  it("routes transport.resync markers to company subscribers through the emitter", async () => {
    await configureLiveEventsTransport({ mode: "postgres", databaseUrl });
    const received: LiveEvent[] = [];
    const unsubscribe = subscribeCompanyLiveEvents("company-resync", (e) => received.push(e));
    await whenTransportSubscribed("company-resync");
    publishLiveEvent({ companyId: "company-resync", type: "transport.resync", payload: { __resync: true } });
    const event = await waitFor(() => received.find((e) => e.type === "transport.resync"));
    expect(event.payload).toEqual({ __resync: true });
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
    await replicaB.whenSubscribed!("company-a");
    // Publisher init is async too; whenSubscribed also awaits client init.
    await replicaA.whenSubscribed!("company-a");

    replicaA.publish(makeEvent({ id: 401 }));
    await waitFor(() => (seenByB.length > 0 ? seenByB[0] : undefined), { timeoutMs: 1000 });
    expect(seenByB[0]?.id).toBe(401);

    // Self-echo: replicaA subscribes to its own channel; the origin filter
    // must suppress its own publish while replicaB still receives it.
    const seenByA: LiveEvent[] = [];
    replicaA.subscribe("company-a", (e) => seenByA.push(e));
    await replicaA.whenSubscribed!("company-a");
    replicaA.publish(makeEvent({ id: 402 }));
    // The mock delivers synchronously: once replicaB has the event, the
    // echo would already have hit replicaA if the filter were broken.
    await waitFor(() => seenByB.find((e) => e.id === 402));
    expect(seenByA.map((e) => e.id)).not.toContain(402);

    await replicaA.close();
    await replicaB.close();
  });

  it("ignores valid-JSON envelopes without an event field instead of throwing", async () => {
    const factory = makeMockRedisFactory();
    const replica = createRedisLiveEventsTransport({
      redisUrl: "redis://test",
      clientFactory: factory,
    });

    const seen: LiveEvent[] = [];
    replica.subscribe("company-a", (e) => seen.push(e));
    await replica.whenSubscribed!("company-a");

    // Inject a malformed envelope (valid JSON, no `event`) directly via a raw
    // publisher client. Without the guard this threw a TypeError out of the
    // ioredis "message" callback; it must be silently dropped instead.
    const { publisher } = factory("redis://test");
    await publisher.publish(
      redisChannelForCompany("company-a"),
      JSON.stringify({ origin: "someone-else", kind: "full" }),
    );

    // A well-formed event published afterwards must still arrive — the
    // subscription survived the malformed payload.
    const other = createRedisLiveEventsTransport({
      redisUrl: "redis://test",
      clientFactory: factory,
    });
    // Client init is async — whenSubscribed awaits it before publishing.
    await other.whenSubscribed!("company-a");
    other.publish(makeEvent({ id: 403 }));
    await waitFor(() => seen.find((e) => e.id === 403));
    expect(seen.map((e) => e.id)).toEqual([403]);

    await replica.close();
    await other.close();
  });

  it("isolates traffic across companies (replica subscribed to A doesn't see B)", async () => {
    const factory = makeMockRedisFactory();
    const publisher = createRedisLiveEventsTransport({ redisUrl: "redis://test", clientFactory: factory });
    const subscriberA = createRedisLiveEventsTransport({ redisUrl: "redis://test", clientFactory: factory });
    const seenByA: LiveEvent[] = [];
    subscriberA.subscribe("company-a", (e) => seenByA.push(e));
    await subscriberA.whenSubscribed!("company-a");
    await publisher.whenSubscribed!("company-a"); // awaits client init

    publisher.publish(makeEvent({ id: 501, companyId: "company-b" }));
    publisher.publish(makeEvent({ id: 502, companyId: "company-a" }));

    // The mock delivers synchronously and 501 was published first, so by
    // the time 502 is visible the leak (if any) would already have landed.
    await waitFor(() => seenByA.find((e) => e.id === 502), { timeoutMs: 1000 });
    expect(seenByA.some((e) => e.companyId === "company-b")).toBe(false);

    await publisher.close();
    await subscriberA.close();
  });

  it("does not apply the Postgres 7.5KB cap to Redis publishes", async () => {
    // Greptile-flagged regression: envelope encoding previously hard-coded
    // PG_NOTIFY_INLINE_LIMIT for every transport, so any event between
    // 7.5KB and Redis's actual buffer limit was silently dropped on the
    // Redis path. A 50KB payload — well within Redis pub/sub buffer
    // limits — must round-trip.
    const factory = makeMockRedisFactory();
    const publisher = createRedisLiveEventsTransport({ redisUrl: "redis://test", clientFactory: factory });
    const subscriber = createRedisLiveEventsTransport({ redisUrl: "redis://test", clientFactory: factory });

    const seen: LiveEvent[] = [];
    subscriber.subscribe("company-a", (e) => seen.push(e));
    await subscriber.whenSubscribed!("company-a");
    await publisher.whenSubscribed!("company-a"); // awaits client init

    // ~50KB payload — > PG_NOTIFY_INLINE_LIMIT (7500) but well under
    // REDIS_PUBSUB_INLINE_LIMIT (1_000_000).
    const big = "x".repeat(50_000);
    publisher.publish(makeEvent({ id: 601, payload: { big } }));

    const got = await waitFor(() => seen.find((e) => e.id === 601), { timeoutMs: 1000 });
    expect(got.id).toBe(601);
    expect((got.payload as { big: string }).big).toHaveLength(50_000);

    await publisher.close();
    await subscriber.close();
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
