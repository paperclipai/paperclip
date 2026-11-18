import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { pokeRunScratchSweep, registerRunScratchSweepWork } from "./run-scratch-sweep-work.js";

type RegisteredTask = Parameters<ReturnType<typeof createDeliveryWorkCoordinator>["register"]>[1];

function stubCoordinator() {
  const registered: Array<{ queue: string; task: RegisteredTask; wake: ReturnType<typeof vi.fn> }> = [];
  const coordinator = {
    register(queue: string, task: RegisteredTask) {
      const wake = vi.fn();
      const stop = vi.fn(async () => {});
      registered.push({ queue, task, wake });
      return { ready: Promise.resolve(), wake, stop };
    },
  } as unknown as ReturnType<typeof createDeliveryWorkCoordinator>;
  return { coordinator, registered };
}

describe("run scratch sweep work", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  });

  it("sweeps at startup, follows up on truncation, retries while cleanup stays pending, then idles", async () => {
    const { coordinator, registered } = stubCoordinator();
    vi.setSystemTime(1_000_000);
    const results: Array<{ truncated: boolean; pending: number }> = [];
    const worker = registerRunScratchSweepWork(coordinator, {
      intervalMs: 60_000,
      canRun: () => true,
      sweep: async () => {
        // First sweep reports truncation; the second an unfinished cleanup;
        // later ones settle.
        const result =
          results.length === 0
            ? { truncated: true, pending: 0 }
            : results.length === 1
              ? { truncated: false, pending: 1 }
              : { truncated: false, pending: 0 };
        results.push(result);
        return result;
      },
    });
    await worker.ready;
    expect(registered).toHaveLength(1);
    expect(registered[0]!.queue).toBe(DELIVERY_QUEUES.runScratchSweep);

    const task = registered[0]!.task;
    expect(task.nextRunAt?.()).toBe(1_000_000);

    // Startup pass: sweeps immediately.
    await task.run(new AbortController().signal);
    expect(results).toHaveLength(1);

    // Within the bounded 30s truncation follow-up: no new sweep yet.
    vi.setSystemTime(1_029_999);
    await task.run(new AbortController().signal);
    expect(results).toHaveLength(1);

    // Truncation follow-up becomes due after 30s, not the full interval.
    vi.setSystemTime(1_030_000);
    await task.run(new AbortController().signal);
    expect(results).toHaveLength(2);
    expect(results[1]!.truncated).toBe(false);

    // An unfinished cleanup retries on the full interval, not sooner.
    vi.setSystemTime(1_089_999);
    await task.run(new AbortController().signal);
    expect(results).toHaveLength(2);
    vi.setSystemTime(1_090_000);
    await task.run(new AbortController().signal);
    expect(results).toHaveLength(3);
    expect(results[2]!.pending).toBe(0);

    // A settled sweep cancels its deadline: no pending work, no scheduled scan.
    expect(task.nextRunAt?.()).toBeNull();
    expect(await task.hasPending(true)).toBe(false);
    vi.setSystemTime(2_000_000);
    await task.run(new AbortController().signal);
    expect(results).toHaveLength(3);
  });

  it("a lifecycle poke wakes an idle sweep without postponing an earlier deadline", async () => {
    const { coordinator, registered } = stubCoordinator();
    vi.setSystemTime(5_000_000);
    const sweeps = vi.fn(async () => ({ truncated: false, pending: 0 }));
    const worker = registerRunScratchSweepWork(coordinator, {
      intervalMs: 60_000,
      canRun: () => true,
      sweep: sweeps,
    });
    await worker.ready;
    const task = registered[0]!.task;
    const wake = registered[0]!.wake;

    // Settle the sweep, then poke it: it must become due immediately.
    await task.run(new AbortController().signal);
    expect(task.nextRunAt?.()).toBeNull();
    vi.setSystemTime(5_500_000);
    pokeRunScratchSweep();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(task.nextRunAt?.()).toBe(5_500_000);
    await task.run(new AbortController().signal);
    expect(sweeps).toHaveBeenCalledTimes(2);

    // A poke never postpones an existing sooner deadline.
    vi.setSystemTime(5_600_000);
    pokeRunScratchSweep();
    pokeRunScratchSweep();
    expect(wake).toHaveBeenCalledTimes(3);
    expect(task.nextRunAt?.()).toBe(5_600_000);

    // Stopping the worker unregisters its poke.
    await worker.stop();
    pokeRunScratchSweep();
    expect(wake).toHaveBeenCalledTimes(3);
  });

  it("skips the sweep while disallowed, advancing a live deadline but leaving an idle one unset", async () => {
    const { coordinator, registered } = stubCoordinator();
    vi.setSystemTime(9_000_000);
    const sweep = vi.fn(async () => ({ truncated: false, pending: 0 }));
    registerRunScratchSweepWork(coordinator, {
      intervalMs: 60_000,
      canRun: () => false,
      sweep,
    });
    const task = registered[0]!.task;
    await task.run(new AbortController().signal);
    expect(sweep).not.toHaveBeenCalled();
    // The skipped deadline advanced, so the coordinator never spins on it.
    expect(task.nextRunAt?.()).toBe(9_000_000 + 60_000);

    // A settled sweep stays idle while disallowed: no deadline is invented.
    const settled = vi.fn(async () => ({ truncated: false, pending: 0 }));
    const second = stubCoordinator();
    let allow = false;
    const worker2 = registerRunScratchSweepWork(second.coordinator, {
      intervalMs: 60_000,
      canRun: () => allow,
      sweep: settled,
    });
    await worker2.ready;
    const task2 = second.registered[0]!.task;
    // First pass (allowed) settles; a later disallowed pass invents nothing.
    allow = true;
    await task2.run(new AbortController().signal);
    expect(task2.nextRunAt?.()).toBeNull();
    allow = false;
    await task2.run(new AbortController().signal);
    expect(task2.nextRunAt?.()).toBeNull();
    expect(settled).toHaveBeenCalledTimes(1);
  });

  it("a failed sweep stays a pending obligation and retries on the interval", async () => {
    const { coordinator, registered } = stubCoordinator();
    vi.setSystemTime(20_000_000);
    let failures = 0;
    const worker = registerRunScratchSweepWork(coordinator, {
      intervalMs: 60_000,
      canRun: () => true,
      sweep: async () => {
        if (failures === 0) {
          failures += 1;
          throw new Error("sweep failed");
        }
        return { truncated: false, pending: 0 };
      },
    });
    await worker.ready;
    const task = registered[0]!.task;
    await expect(task.run(new AbortController().signal)).rejects.toThrow("sweep failed");
    expect(task.nextRunAt?.()).toBe(20_000_000 + 60_000);
    expect(await task.hasPending(true)).toBe(true);
    vi.setSystemTime(20_060_000);
    await task.run(new AbortController().signal);
    expect(task.nextRunAt?.()).toBeNull();
    void worker;
  });

  it("a lifecycle poke during an in-flight scan prevents the worker from idling over missed state", async () => {
    const { coordinator, registered } = stubCoordinator();
    vi.setSystemTime(30_000_000);
    let inFlight: (() => void) | null = null;
    const sweeps = vi.fn(async () => {
      // The scan finishes only after the poke lands mid-flight.
      await new Promise<void>((resolve) => { inFlight = resolve; });
      return { truncated: false, pending: 0 };
    });
    const worker = registerRunScratchSweepWork(coordinator, {
      intervalMs: 60_000,
      canRun: () => true,
      sweep: sweeps,
    });
    await worker.ready;
    const task = registered[0]!.task;

    const running = task.run(new AbortController().signal);
    await vi.waitFor(() => expect(inFlight).not.toBeNull());
    vi.setSystemTime(30_010_000);
    pokeRunScratchSweep(); // a run prepared scratch while the scan was waiting
    inFlight!();
    await running;

    // The settled-looking result must not idle: the missed poke forces an
    // immediate rescan that observes the new state.
    expect(task.nextRunAt?.()).toBeGreaterThanOrEqual(30_010_000);
    expect(await task.hasPending(true)).toBe(true);
    let secondInFlight: (() => void) | null = null;
    sweeps.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { secondInFlight = resolve; });
      return { truncated: false, pending: 1 };
    });
    const rescan = task.run(new AbortController().signal);
    await vi.waitFor(() => expect(secondInFlight).not.toBeNull());
    secondInFlight!();
    await rescan;
    expect(sweeps).toHaveBeenCalledTimes(2);
    // A real obligation keeps the full interval retry from the rescan time.
    expect(task.nextRunAt?.()).toBeGreaterThanOrEqual(30_010_000 + 60_000);
    await worker.stop();
  });
});
