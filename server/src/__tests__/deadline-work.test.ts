import { idleWorkSnapshot } from "../services/task-admission.js";
import { installDatabaseWorkSignals, signalDatabaseWork, databaseWorkPending } from "../../../packages/db/src/work-signals.js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerDeadlineWork } from "../services/deadline-work.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";

let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
afterEach(async () => { await coordinator?.stop(); vi.useRealTimers(); });

it.each([
  { due: "overdue", spacing: 0, delay: 250 },
  { due: "overdue", spacing: 1_000, delay: 1_000 },
  { due: "future", spacing: 0, delay: 5 },
  { due: "future", spacing: 1_000, delay: 1_000 },
])("preserves $due continuation with $spacing ms minimum spacing and disarms after settlement", async ({ due, spacing, delay }) => {
  vi.useFakeTimers();
  const onError = vi.fn();
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  const now = Date.now();
  const run = vi.fn(async () => {});
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.agentTimers, {
    run,
    next: async () => run.mock.calls.length === 1 ? now + (due === "future" ? 5 : -1) : null,
    canRun: () => true,
    retryMs: 30_000,
    continuationMs: 250,
    minimumSpacingMs: spacing,
  });
  await worker.ready;
  expect(run).toHaveBeenCalledOnce();
  expect(coordinator.nextWakeAt()).toBe(now + delay);
  await vi.advanceTimersByTimeAsync(delay - 1);
  expect(run).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(2);
  expect(coordinator.nextWakeAt()).toBeNull();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(2);
  expect(onError).not.toHaveBeenCalled();
});

it("releases a settled first-write hold during drain and retains a probe-free resume wake", async () => {
  vi.useFakeTimers();
  let draining = false;
  const owner = installDatabaseWorkSignals({
    execute: vi.fn(async () => [{ status: "committed" }]),
    transaction: async (callback: (tx: object) => Promise<unknown>) => callback({ execute: async () => [{ xid: "1" }] }),
  });
  const run = vi.fn(async () => {}), next = vi.fn(async () => null);
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => !draining, canReconcile: () => true, onError: vi.fn() });
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.agentTimers, { run, next, canRun: () => !draining, retryMs: 30_000 });
  await worker.ready;
  draining = true;
  const before = idleWorkSnapshot().active;
  await owner.transaction(async tx => { await signalDatabaseWork(tx, DELIVERY_QUEUES.agentTimers); });
  await vi.advanceTimersByTimeAsync(0);
  expect(idleWorkSnapshot().active).toBe(before);
  expect(coordinator.nextWakeAt()).not.toBeNull();
  await vi.advanceTimersByTimeAsync(3 * 30_000);
  expect(run).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce(); expect(owner.execute).not.toHaveBeenCalled();
  draining = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledTimes(2); expect(coordinator.nextWakeAt()).toBeNull();
});

it("retains failed work through drain and preserves a future domain deadline", async () => {
  vi.useFakeTimers();
  let draining = false;
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  const run = vi.fn(async () => { if (run.mock.calls.length === 1) { draining = true; throw new Error("retry debt"); } });
  const deadline = Date.now() + 600_000;
  const next = vi.fn(async () => deadline);
  const onError = vi.fn();
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => !draining, canReconcile: () => true, onError });
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.agentTimers, { run, next, canRun: () => !draining, retryMs: 30_000 });
  await worker.ready;
  await vi.advanceTimersByTimeAsync(90_000);
  expect(run).toHaveBeenCalledOnce(); expect(next).not.toHaveBeenCalled(); expect(owner.execute).not.toHaveBeenCalled();
  draining = false; await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledTimes(2); expect(coordinator.nextWakeAt()).toBe(deadline);
  draining = true; await vi.advanceTimersByTimeAsync(30_000);
  expect(coordinator.nextWakeAt()).toBe(deadline); expect(onError).toHaveBeenCalledOnce();
});

it("does no domain probes in warm standby and reconstructs after admission opens", async () => {
  vi.useFakeTimers();
  let standby = true;
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  const run = vi.fn(async () => {}), next = vi.fn(async () => null);
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => !standby, canReconcile: () => !standby, onError: vi.fn() });
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.agentTimers, { run, next, canRun: () => !standby, retryMs: 30_000 });
  await worker.ready; await vi.advanceTimersByTimeAsync(90_000);
  expect(run).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled(); expect(owner.execute).not.toHaveBeenCalled();
  standby = false; await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledOnce(); expect(coordinator.nextWakeAt()).toBeNull();
});

it("does not release an ambiguous database intent while dispatch is drained", async () => {
  vi.useFakeTimers();
  let draining = false, committed = false;
  const owner = installDatabaseWorkSignals({
    execute: vi.fn(async () => [{ status: committed ? "committed" : "in progress" }]),
    transaction: async (callback: (tx: object) => Promise<unknown>) => {
      await callback({ execute: async () => [{ xid: "2" }] });
      throw new Error("lost acknowledgement");
    },
  });
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => !draining, canReconcile: () => true, onError: vi.fn() });
  const run = vi.fn(async () => {});
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.agentTimers, { run, next: async () => null, canRun: () => !draining, retryMs: 30_000 });
  await worker.ready; draining = true;
  const before = idleWorkSnapshot().active;
  await expect(owner.transaction(async tx => { await signalDatabaseWork(tx, DELIVERY_QUEUES.agentTimers); })).rejects.toThrow("lost acknowledgement");
  await vi.advanceTimersByTimeAsync(0);
  expect(idleWorkSnapshot().active).toBe(before + 1);
  expect(databaseWorkPending(owner, DELIVERY_QUEUES.agentTimers)).toBe(true);
  committed = true; await vi.advanceTimersByTimeAsync(30_000);
  expect(databaseWorkPending(owner, DELIVERY_QUEUES.agentTimers)).toBe(false);
  expect(idleWorkSnapshot().active).toBe(before);
  draining = false; await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledTimes(2); expect(coordinator.nextWakeAt()).toBeNull();
});

it("backs off an expired deadline when only the domain is drained and resumes promptly", async () => {
  vi.useFakeTimers();
  let paused = false;
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  const run = vi.fn(async () => {});
  const domainCanRun = vi.fn(() => !paused);
  const deadline = Date.now() + 1_000;
  const next = vi.fn(async () => run.mock.calls.length === 1 ? deadline : null);
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError: vi.fn() });
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.agentTimers, {
    run, next, canRun: domainCanRun, retryMs: 30_000,
  });
  await worker.ready;
  paused = true;
  const before = idleWorkSnapshot();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(coordinator.nextWakeAt()).toBe(Date.now() + 30_000);
  const attempts = domainCanRun.mock.calls.length;
  await vi.advanceTimersByTimeAsync(90_000);
  expect(domainCanRun.mock.calls.length - attempts).toBeLessThanOrEqual(12);
  // Four attempts (expiry plus three retries), each begins and ends tracked work.
  expect(idleWorkSnapshot().generation - before.generation).toBe(8);
  expect(idleWorkSnapshot().active).toBe(before.active);
  expect(run).toHaveBeenCalledOnce(); expect(next).toHaveBeenCalledOnce(); expect(owner.execute).not.toHaveBeenCalled();
  paused = false;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledTimes(2); expect(coordinator.nextWakeAt()).toBeNull();
});

it("retains a prompt paused wake when a new request preempts a far-future deadline", async () => {
  vi.useFakeTimers();
  let paused = false;
  const owner = installDatabaseWorkSignals({ execute: vi.fn(async () => []) });
  const run = vi.fn(async () => {});
  const deadline = Date.now() + 86_400_000;
  coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError: vi.fn() });
  const worker = registerDeadlineWork(coordinator, DELIVERY_QUEUES.agentTimers, {
    run, next: async () => run.mock.calls.length === 1 ? deadline : null, canRun: () => !paused, retryMs: 30_000,
  });
  await worker.ready; paused = true; worker.wake();
  await vi.advanceTimersByTimeAsync(0);
  expect(coordinator.nextWakeAt()).toBe(Date.now() + 30_000);
  expect(owner.execute).not.toHaveBeenCalled();
  paused = false; await vi.advanceTimersByTimeAsync(30_000);
  expect(run).toHaveBeenCalledTimes(2); expect(coordinator.nextWakeAt()).toBeNull();
});
