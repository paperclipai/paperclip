import { describe, expect, it } from "vitest";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { createNativeTurnAccounting, nativeUsageBiller, nativeUsageCostUsd, normalizeNativeUsage, usesNativeUsageDelivery } from "./native-usage-accounting.js";

const provider = { kind: "opencode" as const, model: "test-model" };
const extension = { kind: "extension" as const, harnessId: "fixture.package/native", model: "exact-model", config: {}, capabilities: { usage: true },
  release: { harnessId: "fixture.package/native", packageName: "@fixture/plugin-native", version: "1.0.0", protocolVersion: 1 as const,
    integrity: "sha256-" + "A".repeat(43) + "=", runtimeDigest: "sha256:" + "a".repeat(64) } };
const event = (sourceSeq: number, eventType: string, turnId = "turn-1", payload: Record<string, unknown> = {}) => ({
  sourceInstanceId: "producer", sourceSeq, eventType, turnId, payload,
} as PrpEvent);

describe("native turn accounting", () => {
  it("selects producer delivery only for supported remote Runner execution", () => {
    expect(usesNativeUsageDelivery({ runnerd: true, remote: true, provider })).toBe(true);
    expect(usesNativeUsageDelivery({ runnerd: false, remote: true, provider })).toBe(false);
    expect(usesNativeUsageDelivery({ runnerd: true, remote: false, provider })).toBe(false);
    expect(usesNativeUsageDelivery({ runnerd: true, remote: true })).toBe(false);
    expect(usesNativeUsageDelivery({ runnerd: true, remote: true, provider: { kind: "cursor_cloud", model: "caller-model" } as never })).toBe(false);
    expect(usesNativeUsageDelivery({ runnerd: true, remote: true, provider: { kind: "muse", model: null } as never })).toBe(false);
    expect(usesNativeUsageDelivery({ runnerd: true, remote: true, provider: extension })).toBe(true);
    expect(usesNativeUsageDelivery({ runnerd: true, remote: false, provider: extension })).toBe(false);
  });

  it("retains package-reported paid usage without inventing a built-in biller", () => {
    expect(nativeUsageBiller(extension)).toBe("unknown");
    const accounting = createNativeTurnAccounting(extension);
    const usage = event(2, "item.completed", "turn-1", { kind: "usage", usage: {
      runDeltaComplete: true, runDelta: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40, providerCostUsd: 0.0025 },
    } });
    accounting.observe(event(1, "turn.started"));
    accounting.observe(usage);
    accounting.observe(usage);
    accounting.observe(event(3, "turn.completed"));
    const snapshot = accounting.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(nativeUsageCostUsd(snapshot.usage, extension)).toBe(0.0025);
    expect(normalizeNativeUsage(snapshot.usage)).toEqual({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 40, cacheWriteTokens: 0 });
  });

  it("reconstructs cumulative turn usage without counting repeated producer events twice", () => {
    const accounting = createNativeTurnAccounting(provider);
    const usage = { kind: "usage", usage: { runDeltaComplete: true, runDelta: { inputTokens: 120, outputTokens: 10, providerCostUsd: 0.25 } } };
    const history = [event(1, "turn.started"), event(2, "item.completed", "turn-1", usage), event(3, "turn.completed"),
      event(4, "turn.started", "turn-2"), event(5, "item.completed", "turn-2", usage), event(6, "turn.completed", "turn-2")];
    history.forEach(value => accounting.observe(value));
    history.forEach(value => accounting.observe(value));
    const snapshot = accounting.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(normalizeNativeUsage(snapshot.usage)).toEqual({ inputTokens: 240, outputTokens: 20, cachedInputTokens: 0, cacheWriteTokens: 0 });
    expect(nativeUsageCostUsd(snapshot.usage, provider)).toBe(0.5);
  });

  it("keeps an incomplete provider report pending instead of trusting placeholder zeroes", () => {
    const accounting = createNativeTurnAccounting(provider);
    accounting.observe(event(1, "turn.started"));
    accounting.observe(event(2, "item.completed", "turn-1", { kind: "usage", usage: {
      runDeltaComplete: false, runDelta: { inputTokens: 0, outputTokens: 0, providerCostUsd: 0 },
    } }));
    accounting.observe(event(3, "turn.completed"));
    expect(accounting.snapshot().complete).toBe(false);
    expect(accounting.snapshot().usage?.accountingCostIncomplete).toBe(true);
    expect(normalizeNativeUsage({ runDeltaComplete: false, runDelta: { inputTokens: 0, outputTokens: 0 } })).toBeUndefined();
  });
});
