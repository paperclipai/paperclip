import { describe, expect, it, vi } from "vitest";

import {
  createLegacyStandaloneStandaloneAdapter,
  createNativeStandaloneStandaloneAdapter,
  resolveStandaloneStandaloneMode,
  runStandaloneStandaloneDemo,
  type StandaloneStandaloneAdapter,
} from "./standalone-demo.js";

function adapterSpy(adapter: StandaloneStandaloneAdapter) {
  return {
    adapter,
    start: vi.spyOn(adapter, "start"),
    stop: vi.spyOn(adapter, "stop"),
  };
}

describe("Standalone standalone demo", () => {
  it("keeps the legacy path as the default", async () => {
    const legacy = adapterSpy(createLegacyStandaloneStandaloneAdapter());
    const createLegacyAdapter = vi.fn(() => legacy.adapter);
    const createNativeAdapter = vi.fn(() => createNativeStandaloneStandaloneAdapter());
    const result = await runStandaloneStandaloneDemo({
      featureFlagEnabled: false,
      killSwitchEnabled: false,
    }, {
      createLegacyAdapter,
      createNativeAdapter,
    });

    expect(createLegacyAdapter).toHaveBeenCalledOnce();
    expect(createNativeAdapter).not.toHaveBeenCalled();
    expect(legacy.start).toHaveBeenCalledOnce();
    expect(legacy.stop).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      adapter: "legacy_demo_adapter",
      resolvedMode: "legacy",
      resolutionReason: "feature_flag_disabled",
      nativeAdapterInvocationCount: 0,
      legacyAdapterInvocationCount: 1,
      replay: { eventCount: 3, highestContiguousSourceSeq: 3 },
      reducer: { integrity: "complete", runPhase: "terminal", runTerminalState: "succeeded" },
      finalization: { resultPersisted: true, terminalPersisted: true },
    });
  });

  it("runs the native demo behind the feature flag", async () => {
    const native = adapterSpy(createNativeStandaloneStandaloneAdapter());
    const createNativeAdapter = vi.fn(() => native.adapter);
    const createLegacyAdapter = vi.fn(() => createLegacyStandaloneStandaloneAdapter());
    const result = await runStandaloneStandaloneDemo({
      featureFlagEnabled: true,
      killSwitchEnabled: false,
    }, {
      createLegacyAdapter,
      createNativeAdapter,
    });

    expect(createNativeAdapter).toHaveBeenCalledOnce();
    expect(createLegacyAdapter).not.toHaveBeenCalled();
    expect(native.start).toHaveBeenCalledOnce();
    expect(native.stop).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      adapter: "native_demo_adapter",
      resolvedMode: "native",
      resolutionReason: "native_demo_enabled",
      nativeAdapterInvocationCount: 1,
      legacyAdapterInvocationCount: 0,
    });
    expect(result.conformance).toMatchObject({
      duplicateDisposition: "duplicate",
      terminalReplayIdempotent: true,
      resultMutationRejected: true,
    });
  });

  it("constructs and invokes only legacy when the kill switch is enabled", async () => {
    expect(resolveStandaloneStandaloneMode({
      featureFlagEnabled: true,
      killSwitchEnabled: true,
    })).toEqual({
      resolvedMode: "legacy",
      resolutionReason: "kill_switch_enabled",
    });

    const legacy = adapterSpy(createLegacyStandaloneStandaloneAdapter());
    const createLegacyAdapter = vi.fn(() => legacy.adapter);
    const createNativeAdapter = vi.fn(() => createNativeStandaloneStandaloneAdapter());
    const result = await runStandaloneStandaloneDemo({
      featureFlagEnabled: true,
      killSwitchEnabled: true,
    }, {
      createLegacyAdapter,
      createNativeAdapter,
    });

    expect(createLegacyAdapter).toHaveBeenCalledOnce();
    expect(createNativeAdapter).not.toHaveBeenCalled();
    expect(legacy.start).toHaveBeenCalledOnce();
    expect(legacy.stop).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      adapter: "legacy_demo_adapter",
      resolvedMode: "legacy",
      resolutionReason: "kill_switch_enabled",
      nativeAdapterInvocationCount: 0,
      legacyAdapterInvocationCount: 1,
      conformance: {
        duplicateDisposition: "duplicate",
        terminalReplayIdempotent: true,
        resultMutationRejected: true,
      },
      reducer: { integrity: "complete", runPhase: "terminal", runTerminalState: "succeeded" },
      finalization: { resultPersisted: true, terminalPersisted: true },
    });
  });
});
