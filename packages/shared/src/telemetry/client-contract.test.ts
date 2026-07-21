import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client.js";
import type { TelemetryConfig, TelemetryState } from "./types.js";

/**
 * Wire-contract suite for the telemetry client.
 *
 * These tests assert the client honors the backend wire contract using ONLY
 * relative invariants derived from injected config — never the server's literal
 * threshold values. There are intentionally no literal `50` / `512` / `524288`
 * / `2` assertion targets in this file: caps are injected small and every bound
 * is checked against the injected config value. This keeps the client
 * "compatible, not a mirror" — server numbers live in config, not test logic.
 */

// The server envelope allow-set (`validators.mjs` ENVELOPE_FIELDS). Any extra
// top-level key would be rejected, so every emitted envelope must be a subset.
const CONTRACT_KEYS = new Set(["app", "schemaVersion", "installId", "version", "events", "batchId"]);

const TEST_STATE: TelemetryState = {
  installId: "contract-install",
  salt: "contract-salt",
  createdAt: "2026-01-01T00:00:00Z",
  firstSeenVersion: "0.0.0",
};

function makeClient(
  config?: Partial<TelemetryConfig>,
  stateFactory: () => TelemetryState = () => TEST_STATE,
  // 0.5 => zero jitter; deterministic backoff.
  random: () => number = () => 0.5,
) {
  return new TelemetryClient(
    { enabled: true, endpoint: "http://localhost:9999/ingest", ...config },
    stateFactory,
    "0.0.0-test",
    random,
  );
}

function sentBodies(): Array<Record<string, unknown>> {
  return vi.mocked(fetch).mock.calls.map((call) => {
    const requestInit = call[1] as RequestInit | undefined;
    return JSON.parse(String(requestInit?.body ?? "{}"));
  });
}

function sentRawBodies(): string[] {
  return vi.mocked(fetch).mock.calls.map((call) => String((call[1] as RequestInit).body));
}

describe("telemetry client wire contract", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits only allow-set keys with schemaVersion '1' on every POST", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const maxEventsPerBatch = 3;
    const client = makeClient({ maxEventsPerBatch });

    for (let i = 0; i < 7; i++) client.trackDynamic("plugin.telemetry.evt", { i });
    await client.flush();

    for (const body of sentBodies()) {
      for (const key of Object.keys(body)) {
        expect(CONTRACT_KEYS.has(key)).toBe(true);
      }
      expect(body.schemaVersion).toBe("1");
    }
  });

  it("never exceeds the injected maxEventsPerBatch on any POST", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const maxEventsPerBatch = 4;
    const client = makeClient({ maxEventsPerBatch });

    for (let i = 0; i < 10; i++) client.trackDynamic("plugin.telemetry.evt", { i });
    await client.flush();

    const bodies = sentBodies();
    expect(bodies.length).toBeGreaterThan(1); // proves it actually chunked
    for (const body of bodies) {
      expect((body.events as unknown[]).length).toBeLessThanOrEqual(maxEventsPerBatch);
    }
  });

  it("never exceeds the injected maxBodyBytes on any POST", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const maxBodyBytes = 1500;
    const client = makeClient({ maxEventsPerBatch: 1000, maxBodyBytes });

    const blob = "y".repeat(300);
    for (let i = 0; i < 12; i++) client.trackDynamic("plugin.telemetry.evt", { i, blob });
    await client.flush();

    const raw = sentRawBodies();
    expect(raw.length).toBeGreaterThan(1); // proves byte-splitting happened
    for (const body of raw) {
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(maxBodyBytes);
    }
  });

  it("a large flush splits into N envelopes that are each count- and byte-compliant", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const maxEventsPerBatch = 5;
    const maxBodyBytes = 4096;
    const client = makeClient({ maxEventsPerBatch, maxBodyBytes });

    for (let i = 0; i < 23; i++) client.trackDynamic("plugin.telemetry.evt", { i });
    await client.flush();

    const bodies = sentBodies();
    const raw = sentRawBodies();
    const total = bodies.reduce((sum, b) => sum + (b.events as unknown[]).length, 0);
    expect(total).toBe(23); // no events lost
    bodies.forEach((body, idx) => {
      expect((body.events as unknown[]).length).toBeLessThanOrEqual(maxEventsPerBatch);
      expect(Buffer.byteLength(raw[idx] as string)).toBeLessThanOrEqual(maxBodyBytes);
    });
  });
});

describe("telemetry client wire contract — retry semantics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries a 429 and re-sends the identical batchId (server idempotency)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = makeClient({
      backoff: { baseDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5, jitterRatio: 0.25 },
    });

    client.trackDynamic("plugin.telemetry.evt", { a: 1 });
    await client.flush();
    await vi.advanceTimersByTimeAsync(1_000);

    const bodies = sentBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]?.batchId).toBe(bodies[1]?.batchId);
    expect(bodies[1]?.events).toEqual(bodies[0]?.events); // no re-mix
    client.stop();
  });

  it("does not retry a terminal 400 or 413", async () => {
    for (const status of [400, 413]) {
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status });
      vi.stubGlobal("fetch", fetchMock);
      const client = makeClient();

      client.trackDynamic("plugin.telemetry.evt", { a: 1 });
      await client.flush();
      await vi.advanceTimersByTimeAsync(120_000);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      client.stop();
      vi.restoreAllMocks();
    }
  });
});

describe("telemetry client wire contract — batchId identity", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives a different batchId for the same events under a different installId", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));

    const a = makeClient(undefined, () => ({ ...TEST_STATE, installId: "install-a" }));
    a.trackDynamic("plugin.telemetry.evt", { a: 1 });
    await a.flush();
    const idA = sentBodies().at(-1)?.batchId;

    vi.mocked(fetch).mockClear();

    const b = makeClient(undefined, () => ({ ...TEST_STATE, installId: "install-b" }));
    b.trackDynamic("plugin.telemetry.evt", { a: 1 });
    await b.flush();
    const idB = sentBodies().at(-1)?.batchId;

    expect(idA).not.toBe(idB);
  });

  it("emits a batchId of at least 32 hex chars — 128-bit collision floor", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const client = makeClient();

    client.trackDynamic("plugin.telemetry.evt", { a: 1 });
    await client.flush();

    const id = sentBodies().at(-1)?.batchId as string;
    expect(id.length).toBeGreaterThanOrEqual(32);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });
});
