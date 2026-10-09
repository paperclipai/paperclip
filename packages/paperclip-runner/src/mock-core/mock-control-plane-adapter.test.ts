import { describe, expect, it } from "vitest";

import { loadConformanceFixture } from "../protocol/conformance-fixture.js";
import { replayConformanceFixture } from "../tracer/conformance-runner.js";
import { MockControlPlaneAdapter } from "./mock-control-plane-adapter.js";

describe("MockControlPlaneAdapter", () => {
  it("exercises the complete control-plane contract path", async () => {
    const fixture = await loadConformanceFixture();
    const mockCore = new MockControlPlaneAdapter();

    await mockCore.start();
    await replayConformanceFixture(mockCore, fixture);

    expect(mockCore.snapshot()).toMatchObject({
      lifecycle: "running",
      openedRun: { identity: fixture.run, backendKind: "mock" },
      events: fixture.events,
      result: fixture.result,
    });
    await mockCore.stop();
  });

  it("rejects events before startup", async () => {
    const fixture = await loadConformanceFixture();
    const mockCore = new MockControlPlaneAdapter();

    await expect(mockCore.appendEvent(fixture.events[0]!)).rejects.toThrow(
      "mock control plane must be started first",
    );
  });
});
