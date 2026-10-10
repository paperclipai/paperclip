import { describe, expect, it } from "vitest";
import { TelemetryClient } from "./client.js";

describe("TelemetryClient event-name types", () => {
  it("keeps dynamic telemetry separate from registered events", () => {
    const client = new TelemetryClient(
      { enabled: false },
      () => ({
        installId: "test-install",
        salt: "test-salt",
        createdAt: "2026-01-01T00:00:00Z",
        firstSeenVersion: "0.0.0",
      }),
      "0.0.0-test",
    );

    client.track("install.started", {});
    client.trackDynamic("plugin.linear.sync_completed", {});

    // @ts-expect-error plugin events are intentionally not registered first-party events.
    client.track("plugin.linear.sync_completed", {});

    expect(client).toBeInstanceOf(TelemetryClient);
  });
});
