import { afterEach, describe, expect, it, vi } from "vitest";
import { StorageChaos, activeStorageWindow, planStorageFaults, replayStorageWindows, type StorageFaultWindow } from "./storage-chaos.js";
import type { StorageFaultRule } from "./storage-proxy.js";

describe("storage fault planning", () => {
  it("plans seeded, non-overlapping windows of the requested kinds across the wave", () => {
    const windows = planStorageFaults({ kinds: ["ST1", "ST2", "ST3"], seed: 7, spanMs: 30 * 60_000 });
    expect(windows.length).toBeGreaterThan(5);
    expect(planStorageFaults({ kinds: ["ST1", "ST2", "ST3"], seed: 7, spanMs: 30 * 60_000 })).toEqual(windows);
    expect(new Set(windows.map(window => window.kind))).toEqual(new Set(["ST1", "ST2", "ST3"]));
    for (const [index, window] of windows.entries()) {
      expect(window.durationMs).toBeGreaterThanOrEqual(60_000);
      expect(window.durationMs).toBeLessThanOrEqual(180_000);
      if (index) expect(window.startMs).toBeGreaterThanOrEqual(windows[index - 1]!.startMs + windows[index - 1]!.durationMs + 60_000);
      if (window.kind === "ST1") expect(window.rules).toEqual([{ fault: { kind: "outage", status: 503 } }]);
      if (window.kind === "ST2") expect(window.rules[0]!.fault).toMatchObject({ kind: "latency" });
      if (window.kind === "ST3") expect(window.rules[0]!.fault).toMatchObject({ kind: "errors", rate: 0.3, status: 503 });
    }
    expect(planStorageFaults({ kinds: [], seed: 7, spanMs: 60_000 })).toEqual([]);
  });

  it("applies each window to the proxy while it is active and clears it afterwards", () => {
    const windows: StorageFaultWindow[] = [{ kind: "ST1", startMs: 1_000, durationMs: 2_000, rules: [{ fault: { kind: "outage" } }] }];
    expect(activeStorageWindow(windows, 999)).toBeNull();
    expect(activeStorageWindow(windows, 1_000)).toBe(windows[0]);
    const applied: Array<readonly StorageFaultRule[] | "clear"> = [];
    const events: string[] = [];
    const chaos = new StorageChaos(windows, 0, { setRules: rules => applied.push(rules), clear: () => applied.push("clear") }, kind => events.push(kind));
    chaos.tick(500); chaos.tick(1_500); chaos.tick(2_000); chaos.tick(3_500);
    expect(applied).toEqual([windows[0]!.rules, "clear"]);
    expect(events).toEqual(["storage_fault_started", "storage_fault_ended"]);
    expect(chaos.receipts).toEqual([{ kind: "ST1", startedAt: 1_500, endedAt: 3_500, rules: windows[0]!.rules }]);
    chaos.tick(1_200);
    chaos.stop(1_300);
    expect(applied.at(-1)).toBe("clear");
  });
});

describe("storage fault clock and replay", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("opens and closes windows on its own clock, not only when the wave loop gets to it", () => {
    vi.useFakeTimers({ now: 0 });
    const windows: StorageFaultWindow[] = [{ kind: "ST1", startMs: 2_000, durationMs: 3_000, rules: [{ fault: { kind: "outage" } }] }];
    const applied: Array<readonly StorageFaultRule[] | "clear"> = [];
    const chaos = new StorageChaos(windows, 0, { setRules: rules => applied.push(rules), clear: () => applied.push("clear") }, () => undefined);
    chaos.start(500);
    vi.advanceTimersByTime(2_500);
    expect(applied).toEqual([windows[0]!.rules]);
    vi.advanceTimersByTime(3_000);
    expect(applied).toEqual([windows[0]!.rules, "clear"]);
    chaos.stop();
    vi.advanceTimersByTime(10_000);
    expect(applied).toHaveLength(2);
  });

  it("measures window offsets from when it starts, so a replay can start the clock at its task's launch", () => {
    vi.useFakeTimers({ now: 0 });
    const windows: StorageFaultWindow[] = [{ kind: "ST1", startMs: 2_000, durationMs: 3_000, rules: [{ fault: { kind: "outage" } }] }];
    const applied: Array<readonly StorageFaultRule[] | "clear"> = [];
    const chaos = new StorageChaos(windows, 0, { setRules: rules => applied.push(rules), clear: () => applied.push("clear") }, () => undefined);
    vi.advanceTimersByTime(60_000);
    chaos.start(500);
    vi.advanceTimersByTime(1_500);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(1_000);
    expect(applied).toEqual([windows[0]!.rules]);
    chaos.stop();
  });

  it("replays the storage windows that crossed a task, at offsets from its launch", () => {
    const rules: StorageFaultRule[] = [{ fault: { kind: "outage", status: 503 } }];
    const receipts = [
      { kind: "ST1" as const, startedAt: 1_000, endedAt: 5_000, rules },
      { kind: "ST2" as const, startedAt: 20_000, endedAt: 30_000, rules: [{ fault: { kind: "latency" as const, ms: 9_000 } }] },
      { kind: "ST1" as const, startedAt: 40_000, endedAt: null, rules },
    ];
    expect(replayStorageWindows(receipts, 10_000, 45_000)).toEqual([
      { kind: "ST2", startMs: 10_000, durationMs: 10_000, rules: receipts[1]!.rules },
      { kind: "ST1", startMs: 30_000, durationMs: 5_000, rules },
    ]);
    expect(replayStorageWindows(receipts, 3_000, 45_000)[0]).toEqual({ kind: "ST1", startMs: 0, durationMs: 2_000, rules });
  });
});

