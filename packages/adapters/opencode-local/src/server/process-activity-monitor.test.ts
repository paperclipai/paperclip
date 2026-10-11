import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOpenCodeProcessActivityMonitor,
  resetOpenCodeProcessActivityScanCacheForTests,
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

describe("sampleOpenCodeProcessActivity shared /proc scan", () => {
  afterEach(() => {
    resetOpenCodeProcessActivityScanCacheForTests();
    vi.useRealTimers();
  });

  const fakeDeps = (calls: { readdir: number; stat: number }) => ({
    readdir: async (_path: string) => {
      calls.readdir += 1;
      return ["1234"];
    },
    readFile: async (path: string) => {
      calls.stat += 1;
      if (path.endsWith("/io")) return "read_bytes: 10\nwrite_bytes: 20\n";
      return "1 (fake) S 0 1234 1234 0 -1 4194560 1 1 0 0 5 5 0 0 0 0 0 0 0 0";
    },
  });

  it("shares one /proc scan across pgid samples within the cache TTL", async () => {
    if (process.platform !== "linux") return;
    resetOpenCodeProcessActivityScanCacheForTests();
    const calls = { readdir: 0, stat: 0 };
    const deps = fakeDeps(calls);
    const first = await sampleOpenCodeProcessActivity(1234, 1234, deps);
    const second = await sampleOpenCodeProcessActivity(1234, 1234, deps);
    expect(calls.readdir).toBe(1);
    expect(second).toEqual(first);
    expect(first?.processIds).toBe("1234");
    expect(first?.cpuTicks).toBe(10);
    expect(first?.ioBytes).toBe(30);
  });

  it("rescans after the cache TTL elapses", async () => {
    if (process.platform !== "linux") return;
    vi.useFakeTimers();
    resetOpenCodeProcessActivityScanCacheForTests();
    const calls = { readdir: 0, stat: 0 };
    const deps = fakeDeps(calls);
    await sampleOpenCodeProcessActivity(1234, 1234, deps);
    vi.setSystemTime(Date.now() + 2_000);
    await sampleOpenCodeProcessActivity(1234, 1234, deps);
    expect(calls.readdir).toBe(2);
  });

  it("filters cached scan snapshots per process group", async () => {
    if (process.platform !== "linux") return;
    resetOpenCodeProcessActivityScanCacheForTests();
    const calls = { readdir: 0, stat: 0 };
    const deps = fakeDeps(calls);
    const own = await sampleOpenCodeProcessActivity(1234, 1234, deps);
    const other = await sampleOpenCodeProcessActivity(1234, 9999, deps);
    expect(calls.readdir).toBe(1);
    expect(own?.processIds).toBe("1234");
    expect(other).toBeNull();
  });

  it("keeps sampling a single pid without touching the shared scan", async () => {
    if (process.platform !== "linux") return;
    resetOpenCodeProcessActivityScanCacheForTests();
    const calls = { readdir: 0, stat: 0 };
    const deps = fakeDeps(calls);
    const snapshot = await sampleOpenCodeProcessActivity(1234, null, deps);
    expect(calls.readdir).toBe(0);
    expect(calls.stat).toBe(2);
    expect(snapshot?.processIds).toBe("1234");
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
