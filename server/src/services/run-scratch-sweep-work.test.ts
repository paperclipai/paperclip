import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerRunScratchSweepWork } from "./run-scratch-sweep-work.js";

type RegisteredTask = Parameters<ReturnType<typeof createDeliveryWorkCoordinator>["register"]>[1];

function stubCoordinator() {
  const registered: Array<{ queue: string; task: RegisteredTask }> = [];
  const coordinator = {
    register(queue: string, task: RegisteredTask) {
      registered.push({ queue, task });
      return { ready: Promise.resolve(), wake: () => {} };
    },
  } as unknown as ReturnType<typeof createDeliveryWorkCoordinator>;
  return { coordinator, registered };
}

describe("run scratch sweep work", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("sweeps at startup, then once per interval, rescheduling sooner while truncated", async () => {
    const { coordinator, registered } = stubCoordinator();
    vi.setSystemTime(1_000_000);
    const results: Array<{ truncated: boolean }> = [];
    const worker = registerRunScratchSweepWork(coordinator, {
      intervalMs: 60_000,
      canRun: () => true,
      sweep: async () => {
        // First sweep reports truncation; later ones complete.
        const result = { truncated: results.length === 0 };
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

    // A complete sweep restores the full interval.
    vi.setSystemTime(1_060_000);
    await task.run(new AbortController().signal);
    expect(results).toHaveLength(2);
    vi.setSystemTime(1_090_000);
    await task.run(new AbortController().signal);
    expect(results).toHaveLength(3);
  });

  it("skips the sweep while disallowed and advances the deadline", async () => {
    const { coordinator, registered } = stubCoordinator();
    vi.setSystemTime(5_000_000);
    const sweep = vi.fn(async () => ({ truncated: false }));
    registerRunScratchSweepWork(coordinator, {
      intervalMs: 60_000,
      canRun: () => false,
      sweep,
    });
    const task = registered[0]!.task;
    vi.setSystemTime(5_000_000);
    await task.run(new AbortController().signal);
    expect(sweep).not.toHaveBeenCalled();
    // The skipped deadline advanced, so the coordinator never spins on it.
    expect(task.nextRunAt?.()).toBe(5_000_000 + 60_000);
  });
});
