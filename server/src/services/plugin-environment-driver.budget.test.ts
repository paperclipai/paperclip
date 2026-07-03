import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePluginExecuteBudget } from "./plugin-environment-driver.js";
import { resolveMaxRpcTimeoutMs } from "./plugin-worker-manager.js";

const BUFFER_MS = 30_000;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolvePluginExecuteBudget", () => {
  it("keeps small requested timeouts intact and adds the RPC buffer on top", () => {
    const budget = resolvePluginExecuteBudget({ requestedTimeoutMs: 60_000, config: {} });
    expect(budget.pluginTimeoutMs).toBe(60_000);
    expect(budget.rpcTimeoutMs).toBe(90_000);
  });

  it("clamps the plugin budget so budget + buffer never exceeds the host RPC cap", () => {
    // 1800000 requested previously produced base+30s clamped to EXACTLY the
    // host cap, so the host timer always fired before the plugin's graceful
    // path. The plugin budget must lose the buffer instead.
    const budget = resolvePluginExecuteBudget({ requestedTimeoutMs: 1_800_000, config: {} });
    expect(budget.pluginTimeoutMs).toBe(15 * 60 * 1000 - BUFFER_MS);
    expect(budget.rpcTimeoutMs).toBe(15 * 60 * 1000);
  });

  it("satisfies the invariant plugin budget + buffer <= host RPC timeout <= cap for any requested timeout", () => {
    const cap = resolveMaxRpcTimeoutMs({});
    for (const requested of [1, 1000, 60_000, 869_999, 870_000, 900_000, 1_800_000, 86_400_000]) {
      const budget = resolvePluginExecuteBudget({ requestedTimeoutMs: requested, config: {} });
      expect(budget.pluginTimeoutMs).toBeDefined();
      expect(budget.rpcTimeoutMs).toBeDefined();
      expect(budget.pluginTimeoutMs! + BUFFER_MS).toBeLessThanOrEqual(budget.rpcTimeoutMs!);
      expect(budget.rpcTimeoutMs!).toBeLessThanOrEqual(cap);
      expect(budget.pluginTimeoutMs!).toBeGreaterThan(0);
    }
  });

  it("falls back to the driver config timeoutMs when no timeout is requested", () => {
    const budget = resolvePluginExecuteBudget({
      requestedTimeoutMs: undefined,
      config: { timeoutMs: 120_000 },
    });
    expect(budget.pluginTimeoutMs).toBe(120_000);
    expect(budget.rpcTimeoutMs).toBe(150_000);
  });

  it("returns undefined budgets when neither a requested nor a config timeout exists (behavior preserved)", () => {
    const budget = resolvePluginExecuteBudget({ requestedTimeoutMs: undefined, config: {} });
    expect(budget.pluginTimeoutMs).toBeUndefined();
    expect(budget.rpcTimeoutMs).toBeUndefined();
  });

  it("respects a raised host cap from PAPERCLIP_PLUGIN_RPC_MAX_TIMEOUT_MS", () => {
    vi.stubEnv("PAPERCLIP_PLUGIN_RPC_MAX_TIMEOUT_MS", "1800000");
    const budget = resolvePluginExecuteBudget({ requestedTimeoutMs: 1_800_000, config: {} });
    expect(budget.pluginTimeoutMs).toBe(1_800_000 - BUFFER_MS);
    expect(budget.rpcTimeoutMs).toBe(1_800_000);
  });

  it("ignores non-positive requested timeouts (same contract as before)", () => {
    const budget = resolvePluginExecuteBudget({ requestedTimeoutMs: 0, config: {} });
    expect(budget.pluginTimeoutMs).toBeUndefined();
    expect(budget.rpcTimeoutMs).toBeUndefined();
  });
});
