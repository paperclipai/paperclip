import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client.js";
import { resolveTelemetryConfig } from "./config.js";
import type { TelemetryState } from "./types.js";

const TEST_STATE: TelemetryState = {
  installId: "test-install",
  salt: "test-salt",
  createdAt: "2026-01-01T00:00:00Z",
  firstSeenVersion: "0.0.0",
};

function makeDisabledClient(stateFactory = vi.fn(() => TEST_STATE)) {
  const client = new TelemetryClient(
    { enabled: true, endpoint: "http://localhost:9999/ingest" },
    stateFactory,
    "0.0.0-test",
    () => 0.5,
  );
  return { client, stateFactory };
}

describe("TelemetryClient permanently disabled", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forces enabled:false even when constructed with enabled:true", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client, stateFactory } = makeDisabledClient();

    client.track("install.started", {});
    client.trackDynamic("plugin.linear.sync_completed", { status: "ok" });
    await client.flush();

    expect(stateFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never schedules periodic flushes", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
      const { client } = makeDisabledClient();
      client.startPeriodicFlush(1000);

      client.track("install.started", {});
      await vi.advanceTimersByTimeAsync(5000);

      expect(fetch).not.toHaveBeenCalled();
      client.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hashPrivateRef returns empty without touching state", () => {
    const { client, stateFactory } = makeDisabledClient();

    expect(client.hashPrivateRef("some-private-ref")).toBe("");
    expect(stateFactory).not.toHaveBeenCalled();
  });
});

// Config surface for soft caps + backoff. Fields are optional and additive;
// `resolveTelemetryConfig` fills documented defaults centrally so no existing
// caller changes behavior.
describe("resolveTelemetryConfig caps + backoff surface", () => {
  it("resolveTelemetryConfig returns default caps and backoff", () => {
    const config = resolveTelemetryConfig();

    expect(config.enabled).toBe(false);
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

    expect(config.enabled).toBe(false);
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

  it("always returns enabled:false, even when asked to enable", () => {
    expect(resolveTelemetryConfig({ enabled: true }).enabled).toBe(false);
    expect(resolveTelemetryConfig({ enabled: true, maxEventsPerBatch: 5 }).enabled).toBe(false);
  });
});
