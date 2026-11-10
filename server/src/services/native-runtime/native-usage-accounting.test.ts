import { describe, expect, it } from "vitest";
import type { PrpEvent } from "../../vendor/paperclip-runner/index.js";
import { createNativeTurnAccounting, nativeUsageCostUsd, normalizeNativeUsage, usesNativeUsageDelivery } from "./native-usage-accounting.js";

const provider = { kind: "opencode" as const, model: "test-model" };
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

  // s7501 run 0a18c2d0 (ACPX Claude): K1 killed the Runner mid-turn. ACPX
  // reports provisional zero usage until a turn ends, so the lost turn never
  // got a complete report. The restored Runner failed it as lost on restore and
  // the continuation turn completed with full usage, yet the receipt stayed
  // incomplete until the 10-minute closure timeout.
  it("closes a run whose earlier turn was lost on restore, as a lower bound", () => {
    const acpx = { kind: "acpx" as const, agent: "claude", model: "claude-sonnet-5" } as never;
    const accounting = createNativeTurnAccounting(acpx);
    const provisional = { kind: "usage", usage: { runDeltaComplete: false,
      runDelta: { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, providerCostUsd: 0 } } };
    const final = { kind: "usage", usage: { runDeltaComplete: true,
      runDelta: { requests: 1, inputTokens: 6, outputTokens: 1446, cacheReadTokens: 124322, cacheWriteTokens: 2794, providerCostUsd: 0 } } };
    [event(7, "turn.started", "turn-lost"), event(10, "item.completed", "turn-lost", provisional),
      event(16, "item.completed", "turn-lost", provisional),
      event(26, "turn.failed", "turn-lost", { status: "failed", error: { code: "provider_turn_lost_on_restore", recoverable: true } }),
      event(29, "turn.started", "turn-next"), event(32, "item.completed", "turn-next", provisional),
      event(70, "item.completed", "turn-next", final)].forEach(value => accounting.observe(value));
    expect(accounting.snapshot().complete).toBe(false);
    accounting.observe(event(73, "turn.completed", "turn-next", { status: "completed" }));
    const snapshot = accounting.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.usage).toMatchObject({ accountingUsageLost: true, accountingCostIncomplete: true });
    expect(normalizeNativeUsage(snapshot.usage)).toEqual({ inputTokens: 2800, outputTokens: 1446, cachedInputTokens: 124322, cacheWriteTokens: 2794 });
  });

  // w-20261110T100747-s20386 run 71f71d10 (ACPX Claude): K1 killed the
  // provider after the agent's finish tool call, before the turn's final usage
  // report. The restored Runner resumed the session and reported the same
  // turn completed without that report, so its receipt stayed incomplete until
  // the 10-minute closure timeout although the result was accepted.
  it("closes a turn that completed across a session restore without its final report, as a lower bound", () => {
    const acpx = { kind: "acpx" as const, agent: "claude", model: "claude-sonnet-5" } as never;
    const provisional = { kind: "usage", usage: { runDeltaComplete: false,
      runDelta: { requests: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, providerCostUsd: 0 } } };
    const before = [event(7, "turn.started", "turn-span"), event(10, "item.completed", "turn-span", provisional),
      event(113, "item.completed", "turn-span", provisional)];
    const restored = [event(119, "session.resumed", undefined as never, { context: {} }),
      event(124, "turn.completed", "turn-span", { status: "completed" })];
    const accounting = createNativeTurnAccounting(acpx);
    [...before, ...restored].forEach(value => accounting.observe(value));
    const snapshot = accounting.snapshot();
    expect(snapshot.complete).toBe(true);
    // The executor certifies completion only when the snapshot names the terminal turn.
    expect(snapshot.turnId).toBe("turn-span");
    expect(snapshot.usage).toMatchObject({ accountingUsageLost: true, accountingCostIncomplete: true });
    // A replay of the same history after another restart reaches the same state.
    const replayed = createNativeTurnAccounting(acpx);
    [...before, ...restored, ...before, ...restored].forEach(value => replayed.observe(value));
    expect(replayed.snapshot()).toEqual(snapshot);
  });

  it("keeps a restored turn's own final report when it arrives after the restore", () => {
    const acpx = { kind: "acpx" as const, agent: "claude", model: "claude-sonnet-5" } as never;
    const accounting = createNativeTurnAccounting(acpx);
    const provisional = { kind: "usage", usage: { runDeltaComplete: false, runDelta: { inputTokens: 0, outputTokens: 0, providerCostUsd: 0 } } };
    const final = { kind: "usage", usage: { runDeltaComplete: true, runDelta: { inputTokens: 40, outputTokens: 7, providerCostUsd: 0.01 } } };
    [event(1, "turn.started", "turn-span"), event(2, "item.completed", "turn-span", provisional),
      event(3, "session.resumed", undefined as never), event(4, "item.completed", "turn-span", final),
      event(5, "turn.completed", "turn-span")].forEach(value => accounting.observe(value));
    const snapshot = accounting.snapshot();
    expect(snapshot.complete).toBe(true);
    expect(snapshot.usage).not.toHaveProperty("accountingUsageLost");
    expect(normalizeNativeUsage(snapshot.usage)).toMatchObject({ inputTokens: 40, outputTokens: 7 });
  });

  it("keeps an incomplete turn pending when the session resumed before it started", () => {
    const accounting = createNativeTurnAccounting(provider);
    accounting.observe(event(1, "session.resumed", undefined as never));
    accounting.observe(event(2, "turn.started"));
    accounting.observe(event(3, "item.completed", "turn-1", { kind: "usage", usage: { runDeltaComplete: false, runDelta: { inputTokens: 0, outputTokens: 0 } } }));
    accounting.observe(event(4, "turn.completed"));
    expect(accounting.snapshot().complete).toBe(false);
  });

  it("keeps a turn that failed for any other reason without usage pending", () => {
    const accounting = createNativeTurnAccounting(provider);
    accounting.observe(event(1, "turn.started"));
    accounting.observe(event(2, "turn.failed", "turn-1", { error: { code: "provider_terminal_error_missing" } }));
    expect(accounting.snapshot().complete).toBe(false);
    expect(accounting.snapshot().usage).not.toHaveProperty("accountingUsageLost");
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
