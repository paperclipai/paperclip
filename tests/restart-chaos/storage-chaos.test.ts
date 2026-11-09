import { describe, expect, it } from "vitest";
import { StorageChaos, activeStorageWindow, planStorageFaults, type StorageFaultWindow } from "./storage-chaos.js";
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
    expect(chaos.receipts).toEqual([{ kind: "ST1", startedAt: 1_500, endedAt: 3_500 }]);
    chaos.tick(1_200);
    chaos.stop(1_300);
    expect(applied.at(-1)).toBe("clear");
  });
});
