import { afterEach, describe, expect, it, vi } from "vitest";
import { TelemetryClient } from "./client.js";
import type { TelemetryState } from "./types.js";

/**
 * Wire-contract suite for the permanently disabled telemetry client.
 *
 * Telemetry is disabled and cannot be re-enabled: the client must never
 * produce network traffic, no matter how many events are tracked.
 */

const TEST_STATE: TelemetryState = {
  installId: "contract-install",
  salt: "contract-salt",
  createdAt: "2026-01-01T00:00:00Z",
  firstSeenVersion: "0.0.0",
};

function makeClient(stateFactory: () => TelemetryState = () => TEST_STATE) {
  return new TelemetryClient(
    { enabled: true, endpoint: "http://localhost:9999/ingest" },
    stateFactory,
    "0.0.0-test",
    () => 0.5,
  );
}

describe("telemetry client wire contract (permanently disabled)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("never POSTs, no matter how many events are tracked", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    const client = makeClient();

    for (let i = 0; i < 23; i++) client.trackDynamic("plugin.telemetry.evt", { i });
    client.track("install.started", {});
    await client.flush();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never initialises state when events are tracked", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    const stateFactory = vi.fn(() => TEST_STATE);
    const client = makeClient(stateFactory);

    client.track("install.started", {});
    client.trackDynamic("plugin.telemetry.evt", { a: 1 });
    await client.flush();

    expect(stateFactory).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
