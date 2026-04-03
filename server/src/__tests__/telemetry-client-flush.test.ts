import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TelemetryClient } from "../../../packages/shared/src/telemetry/client.js";
import type { TelemetryConfig, TelemetryState } from "../../../packages/shared/src/telemetry/types.js";

function makeClient(config?: Partial<TelemetryConfig>) {
  const merged: TelemetryConfig = { enabled: true, endpoint: "http://localhost:9999/ingest", ...config };
  const state: TelemetryState = {
    installId: "test-install",
    salt: "test-salt",
    createdAt: "2026-01-01T00:00:00Z",
    firstSeenVersion: "0.0.0",
  };
  return new TelemetryClient(merged, () => state, "0.0.0-test");
}

describe("TelemetryClient periodic flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("flushes queued events on interval", async () => {
    const client = makeClient();
    client.startPeriodicFlush(1000);

    client.track("install.started");
    expect(fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Second tick with no new events — no additional call
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(1);

    // New event gets flushed on next tick
    client.track("install.started");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch).toHaveBeenCalledTimes(2);

    client.stop();
  });

  it("stop() prevents further flushes", async () => {
    const client = makeClient();
    client.startPeriodicFlush(1000);

    client.track("install.started");
    client.stop();

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("startPeriodicFlush is idempotent", () => {
    const client = makeClient();
    client.startPeriodicFlush(1000);
    client.startPeriodicFlush(1000); // should not throw or double-fire
    client.stop();
  });
});
