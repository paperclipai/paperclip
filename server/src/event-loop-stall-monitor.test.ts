import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyEventLoopStall,
  startEventLoopStallMonitor,
  type EventLoopStall,
} from "./event-loop-stall-monitor.js";

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the stall report");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const blockWithCpu = (ms: number) => {
  const until = Date.now() + ms;
  let spin = 0;
  while (Date.now() < until) spin += 1;
  return spin;
};

// Blocks the main thread without using CPU, like a sync read on a stalled disk
// or a sync child process.
const blockOffCpu = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

describe("event-loop stall monitor", () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    while (stops.length > 0) stops.pop()!();
    vi.useRealTimers();
  });

  const start = (options: Parameters<typeof startEventLoopStallMonitor>[0]) => {
    const monitor = startEventLoopStallMonitor(options);
    stops.push(monitor.stop);
    return monitor;
  };

  it("records a main-thread CPU block with its duration and CPU time", async () => {
    const stalls: EventLoopStall[] = [];
    const caused = () => stalls.filter((stall) => stall.stallMs >= 700);
    start({ log: (stall) => stalls.push(stall), intervalMs: 20, thresholdMs: 250, probes: { readCgroupThrottledUsec: async () => null } });
    await new Promise((resolve) => setTimeout(resolve, 60));

    blockWithCpu(800);
    await waitFor(() => caused().length > 0);

    // A loaded runner can add unrelated pauses; check the one this test caused.
    const [stall] = caused();
    expect(stall!.cpuUserMs + stall!.cpuSystemMs).toBeGreaterThanOrEqual(400);
    expect(stall!.likelyCause).toBe("main_thread_cpu");
    expect(Date.parse(stall!.stallEndedAt) - Date.parse(stall!.stallStartedAt)).toBeGreaterThanOrEqual(700);
  });

  it("records an off-CPU block, such as sync I/O, as blocked_off_cpu", async () => {
    const stalls: EventLoopStall[] = [];
    const caused = () => stalls.filter((stall) => stall.stallMs >= 700);
    start({ log: (stall) => stalls.push(stall), intervalMs: 20, thresholdMs: 250, probes: { readCgroupThrottledUsec: async () => null } });
    await new Promise((resolve) => setTimeout(resolve, 60));

    blockOffCpu(800);
    await waitFor(() => caused().length > 0);

    const [stall] = caused();
    expect(stall!.likelyCause).toBe("blocked_off_cpu");
  });

  const fakeProbes = (state: { monotonic: number; throttledUsec: number | null; fsRead: number }) => ({
    monotonicNow: () => state.monotonic,
    wallNow: () => 1_794_298_792_000 + state.monotonic,
    cpuUsage: () => ({ user: 0, system: 0 }),
    resourceUsage: () => ({
      majorPageFault: 0, minorPageFault: 0, fsRead: state.fsRead, fsWrite: 0,
      voluntaryContextSwitches: 0, involuntaryContextSwitches: 0,
    }),
    readCgroupThrottledUsec: async () => state.throttledUsec,
  });

  it("stays silent while the loop is responsive and after stop", async () => {
    vi.useFakeTimers();
    const state = { monotonic: 0, throttledUsec: null, fsRead: 0 };
    const log = vi.fn();
    const monitor = start({ log, intervalMs: 500, thresholdMs: 2_000, gcEntries: () => [], probes: fakeProbes(state) });
    for (let tick = 1; tick <= 10; tick++) {
      state.monotonic = tick * 500 + 100;
      await vi.advanceTimersByTimeAsync(500);
    }
    expect(log).not.toHaveBeenCalled();

    monitor.stop();
    state.monotonic += 60_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps the I/O deltas of the stall while the cgroup read is pending", async () => {
    vi.useFakeTimers();
    const state = { monotonic: 0, throttledUsec: 5_000_000 as number | null, fsRead: 10 };
    const stalls: EventLoopStall[] = [];
    start({ log: (stall) => stalls.push(stall), intervalMs: 500, thresholdMs: 2_000, gcEntries: () => [], probes: fakeProbes(state) });
    await vi.advanceTimersByTimeAsync(0);

    state.monotonic = 100_500;
    state.fsRead = 4_010;
    await vi.advanceTimersByTimeAsync(500);

    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ fsReads: 4_000, cgroupThrottledMs: 0, likelyCause: "blocked_off_cpu" });
  });

  it("reports cgroup throttling measured across the stall", async () => {
    vi.useFakeTimers();
    let monotonic = 0;
    let throttledUsec = 1_000_000;
    const stalls: EventLoopStall[] = [];
    start({
      log: (stall) => stalls.push(stall),
      intervalMs: 500,
      thresholdMs: 2_000,
      gcEntries: () => [],
      probes: {
        monotonicNow: () => monotonic,
        wallNow: () => 1_794_298_792_000 + monotonic,
        cpuUsage: () => ({ user: 0, system: 0 }),
        resourceUsage: () => ({
          majorPageFault: 0, minorPageFault: 0, fsRead: 0, fsWrite: 0,
          voluntaryContextSwitches: 0, involuntaryContextSwitches: 0,
        }),
        readCgroupThrottledUsec: async () => throttledUsec,
      },
    });
    await vi.advanceTimersByTimeAsync(0);

    monotonic = 100_500;
    throttledUsec += 90_000_000;
    await vi.advanceTimersByTimeAsync(500);

    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({
      stallMs: 100_000,
      stallStartedAt: "2026-11-10T08:19:52.000Z",
      stallEndedAt: "2026-11-10T08:21:32.500Z",
      cgroupThrottledMs: 90_000,
      likelyCause: "cpu_throttled",
    });
  });

  it("classifies each cause from the measured deltas", () => {
    const base = { stallMs: 100_000, monotonicElapsedMs: 100_500, wallElapsedMs: 100_500, cpuMs: 0, gcPauseMs: 0, majorPageFaults: 0, cgroupThrottledMs: null };
    expect(classifyEventLoopStall(base)).toBe("blocked_off_cpu");
    expect(classifyEventLoopStall({ ...base, cpuMs: 99_000 })).toBe("main_thread_cpu");
    expect(classifyEventLoopStall({ ...base, cpuMs: 99_000, gcPauseMs: 95_000 })).toBe("gc");
    expect(classifyEventLoopStall({ ...base, majorPageFaults: 50_000 })).toBe("memory_paging");
    expect(classifyEventLoopStall({ ...base, cgroupThrottledMs: 80_000 })).toBe("cpu_throttled");
    expect(classifyEventLoopStall({ ...base, monotonicElapsedMs: 500 })).toBe("host_suspended");
  });
});
