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

function makeClient() {
  const stateFactory = vi.fn(() => TEST_STATE);
  return {
    client: new TelemetryClient(
      { enabled: true, endpoint: "http://localhost:9999/ingest" },
      stateFactory,
      "0.0.0-test",
      () => 0.5,
    ),
    stateFactory,
  };
}

describe("proposed server.started event", () => {
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

  it("is swallowed by the real client until the schema registers it", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const { client, stateFactory } = makeClient();

    expect(client.isRegisteredEventName("server.started")).toBe(false);
    trackServerStarted(client, { os_platform: process.platform });
    await client.flush();

    expect(stateFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
