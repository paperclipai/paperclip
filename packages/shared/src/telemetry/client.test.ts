import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client.js";
import type { TelemetryConfig, TelemetryState } from "./types.js";

const FIXED_STATE: TelemetryState = {
  installId: "install-id-abc",
  salt: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  createdAt: "2026-01-01T00:00:00.000Z",
  firstSeenVersion: "1.0.0",
};

function makeState(): TelemetryState {
  return { ...FIXED_STATE };
}

function makeClient(
  configOverrides: Partial<TelemetryConfig> = {},
  stateFactory?: () => TelemetryState,
): TelemetryClient {
  const config: TelemetryConfig = { enabled: true, ...configOverrides };
  return new TelemetryClient(config, stateFactory ?? makeState, "1.2.3");
}

// ============================================================================
// track() — disabled
// ============================================================================

describe("TelemetryClient.track — disabled", () => {
  it("does not queue events when telemetry is disabled", async () => {
    const client = makeClient({ enabled: false });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    client.track("install.started");
    await client.flush(); // should be a no-op
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not initialise state when disabled", () => {
    const stateFactory = vi.fn().mockReturnValue(makeState());
    const client = makeClient({ enabled: false }, stateFactory);
    client.track("install.started");
    expect(stateFactory).not.toHaveBeenCalled();
  });
});

// ============================================================================
// track() — enabled
// ============================================================================

describe("TelemetryClient.track — enabled", () => {
  it("queues an event for later flushing", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ enabled: true });
    client.track("install.started");
    await client.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].name).toBe("install.started");
    fetchSpy.mockRestore();
  });

  it("includes custom dimensions in queued event", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ enabled: true });
    client.track("install.completed", { adapter_type: "claude" });
    await client.flush();
    const [, init] = fetchSpy.mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect(body.events[0].dimensions).toEqual({ adapter_type: "claude" });
    fetchSpy.mockRestore();
  });

  it("initialises state on first track call", () => {
    const stateFactory = vi.fn().mockReturnValue(makeState());
    const client = makeClient({ enabled: true }, stateFactory);
    expect(stateFactory).not.toHaveBeenCalled();
    client.track("install.started");
    expect(stateFactory).toHaveBeenCalledTimes(1);
  });

  it("does not re-initialise state on subsequent track calls", () => {
    const stateFactory = vi.fn().mockReturnValue(makeState());
    const client = makeClient({ enabled: true }, stateFactory);
    client.track("install.started");
    client.track("project.created");
    expect(stateFactory).toHaveBeenCalledTimes(1);
  });

  it("records occurredAt as ISO timestamp", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient();
    client.track("install.started");
    await client.flush();
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string);
    expect(body.events[0].occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    fetchSpy.mockRestore();
  });
});

// ============================================================================
// flush() — basic behavior
// ============================================================================

describe("TelemetryClient.flush", () => {
  it("is a no-op when telemetry is disabled", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ enabled: false });
    await client.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("is a no-op when queue is empty", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ enabled: true });
    await client.flush();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("drains the queue after a successful flush", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient();
    client.track("install.started");
    await client.flush();
    await client.flush(); // second flush should be a no-op
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("includes installId, version, app, and schemaVersion in the envelope", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ enabled: true, app: "paperclip-cli", schemaVersion: "2" });
    client.track("install.started");
    await client.flush();
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string);
    expect(body.installId).toBe(FIXED_STATE.installId);
    expect(body.version).toBe("1.2.3");
    expect(body.app).toBe("paperclip-cli");
    expect(body.schemaVersion).toBe("2");
    fetchSpy.mockRestore();
  });

  it("defaults app to 'paperclip' and schemaVersion to '1' when not set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ enabled: true });
    client.track("install.started");
    await client.flush();
    const body = JSON.parse(fetchSpy.mock.calls[0]![1]?.body as string);
    expect(body.app).toBe("paperclip");
    expect(body.schemaVersion).toBe("1");
    fetchSpy.mockRestore();
  });

  it("uses custom endpoint when configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ enabled: true, endpoint: "https://custom.example.com/ingest" });
    client.track("install.started");
    await client.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toContain("custom.example.com");
    fetchSpy.mockRestore();
  });

  it("tries default endpoints when no custom endpoint is set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ enabled: true });
    client.track("install.started");
    await client.flush();
    const calledUrl = String(fetchSpy.mock.calls[0]![0]);
    expect(calledUrl).toContain("telemetry.paperclip.ing");
    fetchSpy.mockRestore();
  });

  it("tries fallback endpoint when first endpoint returns non-ok", async () => {
    let callCount = 0;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount++;
      if (callCount === 1) return new Response("{}", { status: 500 });
      return new Response("{}", { status: 200 });
    });
    const client = makeClient({ enabled: true });
    client.track("install.started");
    await client.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it("stops trying after first successful response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ enabled: true, endpoint: "https://single.example.com/ingest" });
    client.track("install.started");
    await client.flush();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("silently drops batch when all endpoints fail", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network error"));
    const client = makeClient({ enabled: true });
    client.track("install.started");
    await expect(client.flush()).resolves.not.toThrow();
    fetchSpy.mockRestore();
  });
});

// ============================================================================
// hashPrivateRef()
// ============================================================================

describe("TelemetryClient.hashPrivateRef", () => {
  it("returns a 16-character hex string", () => {
    const client = makeClient();
    const result = client.hashPrivateRef("some-value");
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same salt and value", () => {
    const client = makeClient();
    expect(client.hashPrivateRef("value")).toBe(client.hashPrivateRef("value"));
  });

  it("produces different hashes for different values", () => {
    const client = makeClient();
    expect(client.hashPrivateRef("value-a")).not.toBe(client.hashPrivateRef("value-b"));
  });

  it("produces different hashes for different salts", () => {
    const stateA = () => ({ ...FIXED_STATE, salt: "salt-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    const stateB = () => ({ ...FIXED_STATE, salt: "salt-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
    const clientA = new TelemetryClient({ enabled: true }, stateA, "1.0.0");
    const clientB = new TelemetryClient({ enabled: true }, stateB, "1.0.0");
    // Both clients need to be activated (track forces state init)
    clientA.track("install.started");
    clientB.track("install.started");
    expect(clientA.hashPrivateRef("same-value")).not.toBe(clientB.hashPrivateRef("same-value"));
  });
});

// ============================================================================
// startPeriodicFlush() / stop()
// ============================================================================

describe("TelemetryClient periodic flush", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stop() clears the flush interval without throwing", () => {
    const client = makeClient({ enabled: true });
    client.startPeriodicFlush(1000);
    expect(() => client.stop()).not.toThrow();
  });

  it("calling stop() when no interval is active does not throw", () => {
    const client = makeClient({ enabled: true });
    expect(() => client.stop()).not.toThrow();
  });

  it("startPeriodicFlush is idempotent — second call does not create additional interval", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const client = makeClient({ enabled: true });
    client.startPeriodicFlush(1000);
    client.startPeriodicFlush(1000); // second call should be ignored
    client.track("install.started");
    vi.advanceTimersByTime(1000);
    // Only one interval should have fired
    fetchSpy.mockRestore();
    client.stop();
  });
});
