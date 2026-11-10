import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerTaskDrainExpiryWork, readTaskDrain, startTaskDrain, stopTaskDrain } from "../services/task-admission.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";

describe("task drain deadline", () => {
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator>;
  let worker: ReturnType<typeof registerTaskDrainExpiryWork>;
  let resume = vi.fn<() => void>();
  const execute = vi.fn(async () => []);
  const transaction = async () => { throw new Error("No transaction is expected for a process-local deadline"); };
  beforeEach(async () => {
    vi.useFakeTimers();
    resume = vi.fn<() => void>();
    execute.mockClear();
    coordinator = createDeliveryWorkCoordinator({ owner: installDatabaseWorkSignals({ execute, transaction }), canRun: () => false,
      canReconcile: () => true, onError: error => { throw error; } });
    worker = registerTaskDrainExpiryWork(coordinator, resume);
    await worker.ready;
  });
  afterEach(async () => {
    await worker.stop(); await coordinator.stop(); stopTaskDrain(); vi.useRealTimers();
  });

  it("releases admission once at its deadline without a status read or periodic sweep", async () => {
    startTaskDrain({ ttlMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.nextWakeAt()).toBe(Date.now() + 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(resume).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(readTaskDrain(new Date())).toBeNull();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["replace", "stop", "shutdown"] as const)("does not resume from an obsolete expiry after %s", async action => {
    startTaskDrain({ ttlMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    if (action === "replace") startTaskDrain({ ttlMs: null });
    if (action === "stop") stopTaskDrain();
    if (action === "shutdown") {
      await worker.stop();
      await coordinator.stop();
      expect(vi.getTimerCount()).toBe(0);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resume).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes its listener on close and rearms an existing drain on a new lifecycle", async () => {
    startTaskDrain({ ttlMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    await worker.stop();
    expect(coordinator.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(readTaskDrain(new Date())).toBeNull();
    expect(resume).not.toHaveBeenCalled();
    startTaskDrain({ ttlMs: 1000 });
    const next = createDeliveryWorkCoordinator({ owner: installDatabaseWorkSignals({ execute, transaction }), canRun: () => true, onError: vi.fn() });
    const resumed = vi.fn();
    const nextWorker = registerTaskDrainExpiryWork(next, resumed);
    try {
      await nextWorker.ready;
      await vi.advanceTimersByTimeAsync(1000);
      expect(resumed).toHaveBeenCalledOnce();
      expect(resume).not.toHaveBeenCalled();
    } finally { await nextWorker.stop(); await next.stop(); }
  });
});
