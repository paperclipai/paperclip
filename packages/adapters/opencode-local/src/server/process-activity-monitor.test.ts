import { describe, expect, it } from "vitest";
import {
  createOpenCodeProcessActivityMonitor,
  sampleOpenCodeProcessActivity,
} from "./process-activity-monitor.js";

describe("sampleOpenCodeProcessActivity", () => {
  it("returns null on non-linux platforms", async () => {
    if (process.platform === "linux") return;
    expect(await sampleOpenCodeProcessActivity(1, null)).toBeNull();
  });

  it("samples a live pid on linux", async () => {
    if (process.platform !== "linux") return;
    const snapshot = await sampleOpenCodeProcessActivity(process.pid, null);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.processIds).toBe(String(process.pid));
    expect(typeof snapshot?.cpuTicks).toBe("number");
  });

  it("returns null for a pid that does not exist", async () => {
    if (process.platform !== "linux") return;
    const snapshot = await sampleOpenCodeProcessActivity(2_000_000_000, null);
    expect(snapshot).toBeNull();
  });
});

describe("createOpenCodeProcessActivityMonitor", () => {
  it("reports activity when ioBytes grow between samples", async () => {
    const activities: number[] = [];
    let calls = 0;
    const snapshots = [
      { cpuTicks: 10, ioBytes: 100, processIds: "1" },
      { cpuTicks: 10, ioBytes: 250, processIds: "1" },
    ];
    const monitor = createOpenCodeProcessActivityMonitor({
      pid: 1,
      processGroupId: null,
      intervalMs: 5,
      sample: async () => snapshots[Math.min(calls++, snapshots.length - 1)],
      setTimer: (cb) => setTimeout(cb, 5),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onActivity: () => activities.push(calls),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    monitor.stop();
    expect(activities.length).toBeGreaterThanOrEqual(1);
  });

  it("does not report activity when the snapshot is unchanged", async () => {
    const activities: number[] = [];
    const monitor = createOpenCodeProcessActivityMonitor({
      pid: 1,
      processGroupId: null,
      intervalMs: 5,
      sample: async () => ({ cpuTicks: 10, ioBytes: 100, processIds: "1" }),
      setTimer: (cb) => setTimeout(cb, 5),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onActivity: () => activities.push(1),
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    monitor.stop();
    expect(activities).toHaveLength(0);
  });

  it("stops polling after stop()", async () => {
    let sampleCalls = 0;
    const monitor = createOpenCodeProcessActivityMonitor({
      pid: 1,
      processGroupId: null,
      intervalMs: 5,
      sample: async () => {
        sampleCalls += 1;
        return { cpuTicks: sampleCalls, ioBytes: 0, processIds: "1" };
      },
      setTimer: (cb) => setTimeout(cb, 5),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      onActivity: () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    monitor.stop();
    const callsAtStop = sampleCalls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sampleCalls).toBe(callsAtStop);
  });
});
