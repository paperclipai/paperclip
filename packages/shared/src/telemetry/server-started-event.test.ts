import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client.js";
import { trackServerStarted } from "./events.js";
import type { TelemetryState } from "./types.js";

const TEST_STATE: TelemetryState = {
  installId: "test-install",
  salt: "test-salt",
  createdAt: "2026-01-01T00:00:00Z",
  firstSeenVersion: "0.0.0",
};

function makeClient(enabled = true) {
  const stateFactory = vi.fn(() => TEST_STATE);
  return {
    client: new TelemetryClient(
      { enabled, endpoint: "http://localhost:9999/ingest" },
      stateFactory,
      "0.0.0-test",
      () => 0.5,
    ),
    stateFactory,
  };
}

describe("registered server.started event", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("passes the raw process.platform value through without normalization", () => {
    const { client } = makeClient();
    const track = vi.spyOn(client, "track");

    trackServerStarted(client, { os_platform: "win32" });
    trackServerStarted(client, { os_platform: "some-future-platform" });

    expect(track.mock.calls).toEqual([
      ["server.started", { os_platform: "win32" }],
      ["server.started", { os_platform: "some-future-platform" }],
    ]);
  });

  it("sends the registered event with only the raw OS family", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client, stateFactory } = makeClient();

    expect(client.isRegisteredEventName("server.started")).toBe(true);
    trackServerStarted(client, { os_platform: process.platform });
    await client.flush();

    expect(stateFactory).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body.events).toEqual([
      { name: "server.started", occurredAt: expect.any(String), dimensions: { os_platform: process.platform } },
    ]);
  });

  it("leaves state and network untouched when disabled", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const { client, stateFactory } = makeClient(false);
    trackServerStarted(client, { os_platform: process.platform });
    await client.flush();
    expect(stateFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
