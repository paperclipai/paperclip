import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { TelemetryClient } from "../../../packages/shared/src/telemetry/client.js";
import type { TelemetryState } from "../../../packages/shared/src/telemetry/types.js";

function makeClient() {
  const state: TelemetryState = {
    installId: "test-install",
    salt: "test-salt",
    createdAt: "2026-01-01T00:00:00Z",
    firstSeenVersion: "0.0.0",
  };
  return new TelemetryClient(
    { enabled: true, endpoint: "http://localhost:9999/ingest" },
    () => state,
    "0.0.0-test",
  );
}

describe("TelemetryClient periodic flush (permanently disabled)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("never flushes queued events on interval", async () => {
    const client = makeClient();
    client.startPeriodicFlush(1000);

    client.track("install.started");
    expect(fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).not.toHaveBeenCalled();

    client.stop();
  });

  it("flush() is a no-op", async () => {
    const client = makeClient();

    client.track("install.started");
    await client.flush();

    expect(fetch).not.toHaveBeenCalled();
    client.stop();
  });

  it("startPeriodicFlush schedules no timers", async () => {
    const client = makeClient();
    client.startPeriodicFlush(1000);
    client.startPeriodicFlush(1000);

    client.track("install.started");
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetch).not.toHaveBeenCalled();
    client.stop();
  });
});
