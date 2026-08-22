import { describe, expect, it } from "vitest";

import { loadPhase0Fixture } from "../protocol/phase0-fixture.js";
import { replayPhase0Fixture } from "../tracer/phase0-runner.js";
import { MockControlPlaneAdapter } from "./mock-control-plane-adapter.js";

describe("MockControlPlaneAdapter", () => {
  it("exercises the complete control-plane contract path", async () => {
    const fixture = await loadPhase0Fixture();
    const mockCore = new MockControlPlaneAdapter();

    await mockCore.start();
    await replayPhase0Fixture(mockCore, fixture);

    expect(mockCore.snapshot()).toMatchObject({
      lifecycle: "running",
      openedRun: { identity: fixture.run, backendKind: "mock" },
      events: fixture.events,
      result: fixture.result,
    });
    await mockCore.stop();
  });

  it("rejects events before startup", async () => {
    const fixture = await loadPhase0Fixture();
    const mockCore = new MockControlPlaneAdapter();

    await expect(mockCore.appendEvent(fixture.events[0]!)).rejects.toThrow(
      "mock control plane must be started first",
    );
  });
});
