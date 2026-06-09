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
    const lastCall = vi.mocked(fetch).mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("http://localhost:9999/ingest");
    const requestInit = lastCall?.[1] as RequestInit | undefined;
    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.headers).toEqual({ "Content-Type": "application/json" });
    const body = JSON.parse(String(requestInit?.body ?? "{}"));
    expect(body).toMatchObject({
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
    expect(body.events[0]?.occurredAt).toEqual(expect.any(String));

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

  it("falls back to the api gateway ingest url when the default hostname fails", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError("getaddrinfo ENOTFOUND telemetry.paperclip.ing"))
      .mockResolvedValueOnce({ ok: true });

    const client = makeClient({ endpoint: undefined });
    client.track("install.started");

    await client.flush();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://telemetry.paperclip.ing/ingest");
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe("https://rusqrrg391.execute-api.us-east-1.amazonaws.com/ingest");
  });

  it("startPeriodicFlush is idempotent", () => {
    const client = makeClient();
    client.startPeriodicFlush(1000);
    client.startPeriodicFlush(1000); // should not throw or double-fire
    client.stop();
  });
});
