import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client.js";
import { resolveTelemetryConfig } from "./config.js";
import type { TelemetryConfig, TelemetryDimensions, TelemetryState } from "./types.js";

const TEST_STATE: TelemetryState = {
  installId: "test-install",
  salt: "test-salt",
  createdAt: "2026-01-01T00:00:00Z",
  firstSeenVersion: "0.0.0",
};

function makeClient(
  stateFactory = vi.fn(() => TEST_STATE),
  config?: Partial<TelemetryConfig>,
  // Seeded RNG for deterministic backoff jitter. 0.5 => zero jitter (the
  // symmetric midpoint), so retry delays equal the un-jittered exponential base.
  random: () => number = () => 0.5,
) {
  return {
    client: new TelemetryClient(
      { enabled: true, endpoint: "http://localhost:9999/ingest", ...config },
      stateFactory,
      "0.0.0-test",
      random,
    ),
    stateFactory,
  };
}

function sentBody() {
  const requestInit = vi.mocked(fetch).mock.calls.at(-1)?.[1] as RequestInit | undefined;
  return JSON.parse(String(requestInit?.body ?? "{}"));
}

// Parsed request bodies for every POST the client made this test, in call order.
function sentBodies(): Array<Record<string, unknown>> {
  return vi.mocked(fetch).mock.calls.map((call) => {
    const requestInit = call[1] as RequestInit | undefined;
    return JSON.parse(String(requestInit?.body ?? "{}"));
  });
}

describe("TelemetryClient runtime event gate", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("swallows proposed first-party events before they touch state or the queue", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client, stateFactory } = makeClient();

    client.track(
      // @ts-expect-error -- proposed-telemetry(PAP-2411): fixture proposal not in generated schema
      "skill_studio.skill_created",
      { sharing_scope: "team" },
    );

    await client.flush();

    expect(stateFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses own-property membership so prototype event names are swallowed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client, stateFactory } = makeClient();

    // @ts-expect-error constructor is grammar-valid but not a registered Paperclip event.
    client.track("constructor", {});
    // @ts-expect-error toString is grammar-valid but not a registered Paperclip event.
    client.track("toString", {});

    await client.flush();

    expect(stateFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps registered event batches unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client, stateFactory } = makeClient();

    client.track("install.started", {});
    await client.flush();

    expect(stateFactory).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentBody()).toMatchObject({
      app: "paperclip",
      schemaVersion: "1",
      installId: "test-install",
      version: "0.0.0-test",
      events: [
        {
          name: "install.started",
          dimensions: {},
        },
      ],
    });
    expect(sentBody().events[0]?.occurredAt).toEqual(expect.any(String));
  });

  it("does not change trackDynamic plugin emission", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client } = makeClient();

    client.trackDynamic("plugin.linear.sync_completed", { status: "ok" });
    await client.flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sentBody().events).toEqual([
      expect.objectContaining({
        name: "plugin.linear.sync_completed",
        dimensions: { status: "ok" },
      }),
    ]);
  });
});

// Config surface for soft caps + backoff. Fields are optional and additive;
// `resolveTelemetryConfig` fills documented defaults centrally so no existing
// caller changes behavior.
describe("resolveTelemetryConfig caps + backoff surface", () => {
  it("resolveTelemetryConfig returns default caps and backoff", () => {
    const config = resolveTelemetryConfig();

    expect(config.maxEventsPerBatch).toBe(50);
    expect(config.maxBodyBytes).toBe(524288);
    expect(config.maxPendingRetryBatches).toBe(20);
    expect(config.backoff).toEqual({
      baseDelayMs: 1_000,
      maxDelayMs: 30_000,
      maxAttempts: 5,
      jitterRatio: 0.25,
    });
  });

  it("honors caps/backoff overrides", () => {
    const config = resolveTelemetryConfig({
      maxEventsPerBatch: 10,
      maxBodyBytes: 1024,
      maxPendingRetryBatches: 3,
      backoff: {
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        maxAttempts: 2,
        jitterRatio: 0.1,
      },
    });

    expect(config.maxEventsPerBatch).toBe(10);
    expect(config.maxBodyBytes).toBe(1024);
    expect(config.maxPendingRetryBatches).toBe(3);
    expect(config.backoff).toEqual({
      baseDelayMs: 500,
      maxDelayMs: 5_000,
      maxAttempts: 2,
      jitterRatio: 0.1,
    });
  });
});

// flush() must never emit an oversized batch. The drained
// queue is sub-divided into envelopes of <= config.maxEventsPerBatch events AND
// <= config.maxBodyBytes serialized bytes, one POST per chunk. Caps are injected
// (small) so assertions are RELATIVE invariants, never server literals.
describe("TelemetryClient chunking (count + bytes)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("splits more than maxEventsPerBatch events into multiple compliant POSTs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const cap = 2;
    const { client } = makeClient(undefined, { maxEventsPerBatch: cap });

    for (let i = 0; i < 5; i++) client.track("install.started", {});
    await client.flush();

    // 5 events / cap 2 => 3 POSTs (2 + 2 + 1)
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = sentBodies();
    expect(bodies.map((b) => (b.events as unknown[]).length)).toEqual([2, 2, 1]);
    for (const body of bodies) {
      expect((body.events as unknown[]).length).toBeLessThanOrEqual(cap);
    }
  });

  it("splits a chunk whose serialized bytes exceed maxBodyBytes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    // Big enough to hold a single fat event but force >1 event to split.
    const maxBodyBytes = 900;
    const { client } = makeClient(undefined, { maxEventsPerBatch: 100, maxBodyBytes });

    const blob = "x".repeat(300);
    for (let i = 0; i < 6; i++) client.trackDynamic("plugin.telemetry.blob", { blob });
    await client.flush();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    for (const call of fetchMock.mock.calls) {
      const body = String((call[1] as RequestInit).body);
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(maxBodyBytes);
    }
  });

  it("drops a single event larger than maxBodyBytes and logs, sending nothing", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = makeClient(undefined, { maxBodyBytes: 200 });

    client.trackDynamic("plugin.telemetry.blob", { blob: "x".repeat(5000) });
    await client.flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

// Every emitted chunk carries a deterministic, salt-free content-hash `batchId`
// so server-side retries de-dupe (202) instead of double-counting. Two
// invariants hold: the hash input includes `installId` (so two installs sending
// identical events get distinct ids), and the id is >= 32 hex chars (128-bit
// collision floor).
describe("TelemetryClient deterministic batchId", () => {
  // `deriveBatchId` intentionally hashes the full event objects, INCLUDING each
  // event's `occurredAt` wall-clock stamp, so the id stays a faithful content
  // hash: two genuinely distinct sends get distinct ids and the server ledger
  // (keyed on `batchId`) counts both. Dropping `occurredAt` from the hash would
  // collapse same-shape sends at different times onto one id and make the server
  // silently drop the later batch as a replay — a silent-loss failure mode.
  // These cross-instance determinism checks therefore freeze the clock so
  // both clients stamp an identical `occurredAt`, isolating the hash's structural
  // determinism from wall-clock skew.
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("emits a batchId on every envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();

    expect(typeof sentBody().batchId).toBe("string");
  });

  it("derives a stable batchId for identical events (idempotent retry key)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const first = makeClient();
    first.client.trackDynamic("plugin.telemetry.evt", { a: 1, b: "two" });
    await first.client.flush();
    const idA = sentBody().batchId;

    vi.mocked(fetch).mockClear();

    const second = makeClient();
    second.client.trackDynamic("plugin.telemetry.evt", { a: 1, b: "two" });
    await second.client.flush();
    const idB = sentBody().batchId;

    // Same installId + same event content => identical id.
    expect(idA).toBe(idB);
  });

  it("derives a different batchId for different events", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const first = makeClient();
    first.client.trackDynamic("plugin.telemetry.evt", { a: 1 });
    await first.client.flush();
    const idA = sentBody().batchId;

    vi.mocked(fetch).mockClear();

    const second = makeClient();
    second.client.trackDynamic("plugin.telemetry.evt", { a: 2 });
    await second.client.flush();
    const idB = sentBody().batchId;

    expect(idA).not.toBe(idB);
  });

  it("derives a different batchId for the same events under a different installId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const stateA = vi.fn(() => ({ ...TEST_STATE, installId: "install-a" }));
    const first = makeClient(stateA);
    first.client.trackDynamic("plugin.telemetry.evt", { a: 1 });
    await first.client.flush();
    const idA = sentBody().batchId;

    vi.mocked(fetch).mockClear();

    const stateB = vi.fn(() => ({ ...TEST_STATE, installId: "install-b" }));
    const second = makeClient(stateB);
    second.client.trackDynamic("plugin.telemetry.evt", { a: 1 });
    await second.client.flush();
    const idB = sentBody().batchId;

    expect(idA).not.toBe(idB);
  });

  it("emits a batchId of at least 32 hex chars (128-bit collision floor)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();

    const id = sentBody().batchId as string;
    expect(id.length).toBeGreaterThanOrEqual(32);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it("does not crash flush on a circular dimension; drops-and-logs it and still sends valid events", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = makeClient();

    // A plugin passing a circular `dimensions` object. `enqueue` shallow-copies
    // the top level, so the cycle survives one level down and would drive both
    // `stableStringify` (deriveBatchId) and `JSON.stringify` (serializedBytes /
    // wire body) into an unhandled throw without the guards.
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    // Cast models an untyped third-party plugin passing a malformed object at
    // runtime — TypeScript would reject the cycle, but the wire path cannot.
    client.trackDynamic("plugin.telemetry.circular", circular as unknown as TelemetryDimensions);
    // A well-formed event queued alongside it must still be delivered.
    client.trackDynamic("plugin.telemetry.ok", { a: 1 });

    // flush() resolves instead of rejecting with a RangeError/TypeError.
    await expect(client.flush()).resolves.toBeUndefined();

    // The circular event was dropped-and-logged (fail loudly), not sent.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("non-serializable dimension (circular reference?)"),
    );

    // The valid event still went out on the wire with a well-formed batchId.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = sentBody();
    expect(body.events).toHaveLength(1);
    expect((body.events as Array<{ name: string }>)[0]?.name).toBe("plugin.telemetry.ok");
    const id = body.batchId as string;
    expect(id.length).toBeGreaterThanOrEqual(32);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });
});

// Batch-grouped retry with capped, jittered exponential
// backoff. Retryable statuses (429/502/503/504 + network) re-send the EXACT
// same events + batchId (no re-mix — preserves server idempotency); terminal
// statuses (400/405/409/413) never retry. Backoff uses the injected seeded RNG
// and retries are driven off fake timers so tests are deterministic.
describe("TelemetryClient batched retry + backoff", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a 429 with the same batchId and eventually succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = makeClient(undefined, {
      backoff: { baseDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5, jitterRatio: 0.25 },
    });

    client.track("install.started", {});
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1); // attempt 1 -> 429, queued for retry

    // Un-jittered delay for attempt 1 == baseDelayMs.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(2); // attempt 2 -> 200

    const bodies = sentBodies();
    expect(bodies[0]?.batchId).toBe(bodies[1]?.batchId); // identical id on retry
    client.stop();
  });

  it("does not retry a terminal 400", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400 });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it("does not retry a terminal 413", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 413 });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();
    await vi.advanceTimersByTimeAsync(120_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    client.stop();
  });

  it("stops after maxAttempts on a persistent 429 and drops-and-logs", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const maxAttempts = 3;
    const { client } = makeClient(undefined, {
      backoff: { baseDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts, jitterRatio: 0.25 },
    });

    client.track("install.started", {});
    await client.flush();
    // Drive all remaining scheduled retries.
    await vi.advanceTimersByTimeAsync(600_000);

    expect(fetchMock).toHaveBeenCalledTimes(maxAttempts);
    expect(warn).toHaveBeenCalled();
    client.stop();
  });

  // Issue 1 (PR #9946): a transient upstream 5xx on the primary endpoint must
  // fall through to the healthy secondary endpoint instead of returning early.
  it("falls through to the secondary endpoint on a transient 5xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 }) // primary endpoint: transient
      .mockResolvedValueOnce({ ok: true }); // secondary endpoint: healthy
    vi.stubGlobal("fetch", fetchMock);
    // Empty endpoint => the two built-in DEFAULT_ENDPOINTS are used.
    const { client } = makeClient(undefined, { endpoint: "" });

    client.track("install.started", {});
    await client.flush();

    // Both endpoints tried within a single attempt; delivered on the secondary,
    // so no retry is queued.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    client.stop();
  });

  // Issue 1 (PR #9946): when every endpoint returns a transient 5xx the status
  // is still surfaced as retryable (not swallowed).
  it("surfaces the transient status for retry when all endpoints 5xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 502 }) // primary
      .mockResolvedValueOnce({ ok: false, status: 502 }) // secondary
      .mockResolvedValue({ ok: true }); // retry succeeds
    vi.stubGlobal("fetch", fetchMock);
    const { client } = makeClient(undefined, {
      endpoint: "",
      backoff: { baseDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5, jitterRatio: 0.25 },
    });

    client.track("install.started", {});
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2); // both endpoints 502 -> queued for retry

    await vi.advanceTimersByTimeAsync(1_000); // attempt 2 -> ok on primary
    expect(fetchMock).toHaveBeenCalledTimes(3);
    client.stop();
  });

  // Issue 3 (PR #9946): an out-of-range `Retry-After` hint is clamped to
  // maxDelayMs rather than overflowing the timer range into a near-immediate
  // (Node-clamped ~1ms) retry.
  it("caps a large Retry-After hint at maxDelayMs", async () => {
    const retryAfterResponse = {
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name === "retry-after" ? "999999999" : null) },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(retryAfterResponse).mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const { client } = makeClient(undefined, {
      backoff: { baseDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5, jitterRatio: 0.25 },
    });

    client.track("install.started", {});
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Well before the cap: without clamping the huge hint overflows the timer
    // range and Node fires it near-immediately, so this would already be 2.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // At the cap the retry fires.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    client.stop();
  });
});

// The pending-retry store is bounded at
// config.maxPendingRetryBatches. On overflow the OLDEST batch is evicted
// (newest prioritized) and each eviction is logged (no silent loss). In-memory
// only. Caps are injected; assertions are relative.
describe("TelemetryClient bounded pending-retry store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("evicts the oldest batch and retries only the newest within the bound", async () => {
    // First 3 POSTs (one per single-event chunk) fail 429; retries then succeed.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = makeClient(undefined, { maxEventsPerBatch: 1, maxPendingRetryBatches: 2 });

    client.trackDynamic("plugin.telemetry.evt", { n: 1 });
    client.trackDynamic("plugin.telemetry.evt", { n: 2 });
    client.trackDynamic("plugin.telemetry.evt", { n: 3 });
    await client.flush();

    // 3 initial attempts (one per chunk), each 429 -> enqueued; the 3rd enqueue
    // overflows the bound (2) and evicts the oldest.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const initial = sentBodies();
    const [oldestId, midId, newestId] = initial.map((b) => b.batchId as string);
    expect(warn).toHaveBeenCalled(); // eviction logged

    await vi.advanceTimersByTimeAsync(120_000);

    // Only the 2 newest were retained and retried; the oldest was dropped.
    const retriedIds = sentBodies()
      .slice(3)
      .map((b) => b.batchId as string);
    expect(retriedIds.sort()).toEqual([midId, newestId].sort());
    expect(retriedIds).not.toContain(oldestId);
    client.stop();
  });

  // Issue 2 (PR #9946): a batch that is immediately evicted by the bound must
  // NOT leave a retry timer behind. With maxPendingRetryBatches: 0 every failed
  // batch is discarded on enqueue, so no timer should ever fire.
  it("schedules no retry timer for a batch evicted on enqueue (bound 0)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = makeClient(undefined, { maxEventsPerBatch: 1, maxPendingRetryBatches: 0 });

    client.trackDynamic("plugin.telemetry.evt", { n: 1 });
    client.trackDynamic("plugin.telemetry.evt", { n: 2 });
    await client.flush();

    // 2 initial attempts (one per chunk); each 429 is enqueued then immediately
    // evicted by the 0 bound, so nothing is retried.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalled(); // eviction logged

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock).toHaveBeenCalledTimes(2); // no timer fired
    client.stop();
  });

  // A batch evicted to keep `pending` within the bound must also have its
  // already-scheduled retry timer cancelled — otherwise each overflow strands a
  // live timer for a batch that no longer exists, and the timer set grows
  // unbounded even though `pending` stays bounded.
  it("cancels the retry timer of a batch evicted from the bounded store", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = makeClient(undefined, { maxEventsPerBatch: 1, maxPendingRetryBatches: 1 });

    client.trackDynamic("plugin.telemetry.evt", { n: 1 });
    client.trackDynamic("plugin.telemetry.evt", { n: 2 });
    client.trackDynamic("plugin.telemetry.evt", { n: 3 });
    await client.flush();

    // 3 chunks each 429 -> enqueued; every enqueue past the first overflows the
    // bound (1) and evicts the previous batch. Only the newest batch survives, so
    // exactly one retry timer should remain live (the two evicted timers were
    // cancelled), not one per failed chunk.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
    client.stop();
  });
});
