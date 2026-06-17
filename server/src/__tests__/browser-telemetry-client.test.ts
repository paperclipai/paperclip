import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { BrowserTelemetryClient } from "../../../packages/shared/src/telemetry/browser/client.js";
import { loadOrCreateBrowserState } from "../../../packages/shared/src/telemetry/browser/state.js";
import type { TelemetryConfig, TelemetryState } from "../../../packages/shared/src/telemetry/types.js";

function makeState(): TelemetryState {
  return {
    installId: "browser-test-install",
    salt: "browser-test-salt",
    createdAt: "2026-01-01T00:00:00Z",
    firstSeenVersion: "0.0.0",
  };
}

function makeClient(config?: Partial<TelemetryConfig>) {
  const merged: TelemetryConfig = {
    enabled: true,
    endpoint: "http://localhost:9999/ingest",
    app: "paperclip-ui",
    ...config,
  };
  return new BrowserTelemetryClient(merged, makeState, "0.0.0-test");
}

describe("BrowserTelemetryClient", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends events with app: paperclip-ui by default", async () => {
    const client = new BrowserTelemetryClient(
      { enabled: true, endpoint: "http://localhost:9999/ingest" },
      makeState,
      "0.0.0-test",
    );
    client.track("ui.page_view", { page: "dashboard" });
    await client.flush();

    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body ?? "{}"));
    expect(body.app).toBe("paperclip-ui");
    expect(body.events[0]?.name).toBe("ui.page_view");
    expect(body.events[0]?.dimensions?.page).toBe("dashboard");
  });

  it("flush sends a valid POST to the ingest endpoint", async () => {
    const client = makeClient();
    client.track("install.started");
    await client.flush();

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("http://localhost:9999/ingest");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body ?? "{}"));
    expect(body).toMatchObject({
      app: "paperclip-ui",
      schemaVersion: "1",
      installId: "browser-test-install",
      version: "0.0.0-test",
    });
    expect(body.events).toHaveLength(1);
    expect(body.events[0]?.name).toBe("install.started");
  });

  it("hashPrivateRef returns a 16-char hex string (SubtleCrypto)", async () => {
    const client = makeClient();
    const hash = await client.hashPrivateRef("my-secret-org");
    expect(hash).toHaveLength(16);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("hashPrivateRef is deterministic for the same salt+value", async () => {
    const client = makeClient();
    const h1 = await client.hashPrivateRef("test-value");
    const h2 = await client.hashPrivateRef("test-value");
    expect(h1).toBe(h2);
  });

  it("hashPrivateRef differs from Node createHash result only by implementation parity (same input → same output)", async () => {
    // Both use SHA-256; ensure the browser client produces the same prefix as expected
    const { createHash } = await import("node:crypto");
    const salt = "browser-test-salt";
    const value = "test-org";
    const nodeHash = createHash("sha256").update(salt + value).digest("hex").slice(0, 16);

    const client = makeClient();
    const browserHash = await client.hashPrivateRef(value);
    expect(browserHash).toBe(nodeHash);
  });

  it("does not send when disabled", async () => {
    const client = makeClient({ enabled: false });
    client.track("install.started");
    await client.flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to the gateway URL when primary endpoint fails", async () => {
    vi.mocked(fetch)
      .mockRejectedValueOnce(new TypeError("network error"))
      .mockResolvedValueOnce({ ok: true });

    const client = new BrowserTelemetryClient(
      { enabled: true },
      makeState,
      "0.0.0-test",
    );
    client.track("install.started");
    await client.flush();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("https://telemetry.paperclip.ing/ingest");
    expect(vi.mocked(fetch).mock.calls[1]?.[0]).toBe(
      "https://rusqrrg391.execute-api.us-east-1.amazonaws.com/ingest",
    );
  });
});

describe("loadOrCreateBrowserState", () => {
  it("creates a new state with valid installId and salt when localStorage is empty", () => {
    // Simulate localStorage unavailable — in Node test env, localStorage is undefined
    const state = loadOrCreateBrowserState("0.0.0-test");
    expect(state.installId).toBeTruthy();
    expect(state.salt).toHaveLength(64);
    expect(state.firstSeenVersion).toBe("0.0.0-test");
  });

  it("returns stable state on repeated calls when localStorage is available", () => {
    const store: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    };
    vi.stubGlobal("localStorage", mockStorage);

    const s1 = loadOrCreateBrowserState("0.0.0");
    const s2 = loadOrCreateBrowserState("0.0.0");
    expect(s1.installId).toBe(s2.installId);
    expect(s1.salt).toBe(s2.salt);

    vi.unstubAllGlobals();
  });
});
