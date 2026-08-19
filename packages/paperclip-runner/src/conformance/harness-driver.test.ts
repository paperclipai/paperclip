import { describe, expect, it } from "vitest";

import { DeterministicHarnessDriver } from "../mock-core/deterministic-harness-driver.js";
import {
  loadHarnessDriverConformanceFixture,
  runHarnessDriverConformance,
} from "./harness-driver.js";

describe("harness-driver conformance V1", () => {
  it("ships a deterministic fixture covering the complete Evals hook set", async () => {
    const fixture = await loadHarnessDriverConformanceFixture();
    expect(fixture.requiredCapabilities).toContain("dynamicTools");
    expect(fixture.unsupportedFeatures).toContain("steering");

    const report = await runHarnessDriverConformance({
      driver: new DeterministicHarnessDriver(),
      fixture,
    });
    expect(report).toMatchObject({
      schema: "paperclip-runner/harness-driver-conformance-report/v1",
      contractVersion: 1,
      eventCount: 7,
      semanticToolCallCount: 1,
      checks: {
        capabilityDescription: true,
        configValidation: true,
        sessionLifecycle: true,
        sessionRecovery: true,
        semanticTools: true,
        eventValidation: true,
        interruptAndCancel: true,
        usage: true,
        transcriptCompleteness: true,
        unsupportedFeatures: true,
      },
    });
  });
});
