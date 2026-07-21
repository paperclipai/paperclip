import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client.js";
import { resolveTelemetryConfig } from "./config.js";
import type { TelemetryConfig, TelemetryState } from "./types.js";

const TEST_STATE: TelemetryState = {
  installId: "test-install",
  salt: "test-salt",
  createdAt: "2026-01-01T00:00:00Z",
  firstSeenVersion: "0.0.0",
};

function makeClient(stateFactory = vi.fn(() => TEST_STATE), config?: Partial<TelemetryConfig>) {
  return {
    client: new TelemetryClient(
      { enabled: true, endpoint: "http://localhost:9999/ingest", ...config },
      stateFactory,
      "0.0.0-test",
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

// Stubs `fetch` to reject the batch with a given non-OK HTTP status for every
// endpoint the client may try. Returns the mock so call counts can be asserted.
function stubFetchStatus(status: number) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, status });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Phase 1 (PAP-2862): characterization pins for today's best-effort, silent-drop
// flush. On ANY non-OK response or network error the drained batch is dropped
// with no re-queue and no second attempt, and no `batchId` is emitted. These pins
// lock the current baseline; Impl-2 (PAP-2853) replaces them when retry lands.
describe("TelemetryClient silent-drop baseline (characterization)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops the batch on a 429 with no re-queue", async () => {
    const fetchMock = stubFetchStatus(429);
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Queue was drained despite the failure: a second flush sends nothing.
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops the batch on a 413 with no re-queue", async () => {
    const fetchMock = stubFetchStatus(413);
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops the batch on a 400 with no re-queue", async () => {
    const fetchMock = stubFetchStatus(400);
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops the batch on network error with no re-queue", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await client.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Phase 2 (PAP-2862): config surface for soft caps + backoff. Fields are optional
// and additive; `resolveTelemetryConfig` fills documented defaults centrally so no
// existing caller changes behavior. Nothing reads these yet — Impl-2 is the first
// consumer.
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

// Phase 3 (PAP-2869): flush() must never emit an oversized batch. The drained
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

// Phase 4 (PAP-2869): every emitted chunk carries a deterministic, salt-free
// content-hash `batchId` so server-side retries de-dupe (202) instead of
// double-counting. The Stage-1 security review binds two conditions: C1 — the
// hash input includes `installId` (so two installs sending identical events get
// distinct ids); C2 — the id is >= 32 hex chars (128-bit collision floor).
describe("TelemetryClient deterministic batchId", () => {
  afterEach(() => {
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

  it("derives a different batchId for the same events under a different installId (C1)", async () => {
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

  it("emits a batchId of at least 32 hex chars (C2 collision floor)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client } = makeClient();

    client.track("install.started", {});
    await client.flush();

    const id = sentBody().batchId as string;
    expect(id.length).toBeGreaterThanOrEqual(32);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });
});
