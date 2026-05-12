import { describe, expect, it, vi } from "vitest";
import { createPluginGateVetoTracker, resolveRunGatePlugins, type RunGatePluginRow } from "../services/heartbeat.js";

const basePlugin = (overrides: Partial<RunGatePluginRow> = {}): RunGatePluginRow => ({
  id: "plugin-a",
  pluginKey: "test-plugin",
  installOrder: 1,
  capabilities: ["run.gate"],
  disabledForCompany: false,
  ...overrides,
});

describe("resolveRunGatePlugins", () => {
  it("returns empty list when no plugins have run.gate", () => {
    const plugins = [basePlugin({ capabilities: ["events.subscribe"] })];
    expect(resolveRunGatePlugins(plugins)).toEqual([]);
  });

  it("returns plugin with run.gate capability", () => {
    const plugins = [basePlugin()];
    const result = resolveRunGatePlugins(plugins);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("plugin-a");
  });

  it("filters out plugins disabled for the company", () => {
    const plugins = [basePlugin({ disabledForCompany: true })];
    expect(resolveRunGatePlugins(plugins)).toEqual([]);
  });

  it("sorts gate plugins by installOrder ascending", () => {
    const plugins = [
      basePlugin({ id: "c", installOrder: 3 }),
      basePlugin({ id: "a", installOrder: 1 }),
      basePlugin({ id: "b", installOrder: 2 }),
    ];
    const result = resolveRunGatePlugins(plugins);
    expect(result.map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("treats null installOrder as Infinity (sorts last)", () => {
    const plugins = [
      basePlugin({ id: "null-order", installOrder: null }),
      basePlugin({ id: "has-order", installOrder: 1 }),
    ];
    const result = resolveRunGatePlugins(plugins);
    expect(result[0].id).toBe("has-order");
    expect(result[1].id).toBe("null-order");
  });
});

describe("createPluginGateVetoTracker", () => {
  it("does not warn when cancels are below the threshold", () => {
    const onWarn = vi.fn();
    const tracker = createPluginGateVetoTracker({ threshold: 3, windowMs: 60_000, onWarn });
    tracker.track("co-1", "plugin-a");
    tracker.track("co-1", "plugin-a");
    tracker.track("co-1", "plugin-a");
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("warns exactly once when threshold is first exceeded", () => {
    const onWarn = vi.fn();
    const tracker = createPluginGateVetoTracker({ threshold: 3, windowMs: 60_000, onWarn });
    for (let i = 0; i < 5; i++) tracker.track("co-1", "plugin-a");
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn).toHaveBeenCalledWith("co-1", "plugin-a", 4);
  });

  it("does not warn again after the first warning within the same window", () => {
    const onWarn = vi.fn();
    const tracker = createPluginGateVetoTracker({ threshold: 2, windowMs: 60_000, onWarn });
    for (let i = 0; i < 10; i++) tracker.track("co-1", "plugin-a");
    expect(onWarn).toHaveBeenCalledOnce();
  });

  it("resets count and warned flag after the window expires", () => {
    vi.useFakeTimers();
    const onWarn = vi.fn();
    const tracker = createPluginGateVetoTracker({ threshold: 2, windowMs: 1_000, onWarn });
    for (let i = 0; i < 5; i++) tracker.track("co-1", "plugin-a");
    expect(onWarn).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1_001);
    for (let i = 0; i < 5; i++) tracker.track("co-1", "plugin-a");
    expect(onWarn).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("tracks different companies independently", () => {
    const onWarn = vi.fn();
    const tracker = createPluginGateVetoTracker({ threshold: 2, windowMs: 60_000, onWarn });
    for (let i = 0; i < 4; i++) tracker.track("co-1", "plugin-a");
    for (let i = 0; i < 4; i++) tracker.track("co-2", "plugin-b");
    expect(onWarn).toHaveBeenCalledTimes(2);
    const calls = onWarn.mock.calls;
    expect(calls.some((c) => c[0] === "co-1")).toBe(true);
    expect(calls.some((c) => c[0] === "co-2")).toBe(true);
  });

  it("tracks different plugins within the same company independently (per-plugin keying)", () => {
    const onWarn = vi.fn();
    const tracker = createPluginGateVetoTracker({ threshold: 2, windowMs: 60_000, onWarn });
    // plugin-a vetoes 4 times — triggers warning for plugin-a
    for (let i = 0; i < 4; i++) tracker.track("co-1", "plugin-a");
    // plugin-b vetoes 2 times — should NOT trigger warning (below threshold)
    tracker.track("co-1", "plugin-b");
    tracker.track("co-1", "plugin-b");
    // Only plugin-a breached, not plugin-b
    expect(onWarn).toHaveBeenCalledOnce();
    expect(onWarn).toHaveBeenCalledWith("co-1", "plugin-a", expect.any(Number));
  });
});
