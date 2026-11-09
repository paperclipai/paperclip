import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { notifyDeliveryWork, DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { beginIdleTrackedWork, idleWorkSnapshot, isIdleTaskDrainActive, readTaskDrain, startTaskDrain, stopTaskDrain } from "../services/task-admission.js";
import { readIdleSleepSafety } from "../services/idle-sleep-safety.js";
import type { Db } from "@paperclipai/db";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => { stopTaskDrain(); for (const c of coordinators.splice(0)) await c.stop(); vi.useRealTimers(); });
function setup() {
  vi.useFakeTimers();
  let outcome = "committed";
  let rejectCommit = false;
  const execute = vi.fn(async () => [{ xid: "42", status: outcome }]);
  const owner = installDatabaseWorkSignals({ execute, async transaction(callback: (tx: any) => Promise<any>) {
    const result = await callback({ execute, transaction: owner.transaction });
    if (rejectCommit) throw new Error("lost commit reply");
    return result;
  } });
  const canRun = vi.fn(() => true), canReconcile = vi.fn(() => false), onError = vi.fn();
  const coordinator = createDeliveryWorkCoordinator({ owner, canRun, canReconcile, onError });
  coordinators.push(coordinator);
  const enqueue = (queue = DELIVERY_QUEUES.feedback as typeof DELIVERY_QUEUES[keyof typeof DELIVERY_QUEUES]) =>
    owner.transaction(tx => notifyDeliveryWork(tx, queue));
  return { owner, canRun, canReconcile, onError, coordinator, enqueue, execute,
    failCommit: () => { rejectCommit = true; outcome = "in progress"; }, settle: (status = "committed") => { outcome = status; } };
}
function task() { return { retryMs: 5000, run: vi.fn(async () => {}), hasPending: vi.fn(async () => false) }; }

describe("delivery work coordinator", () => {
  it("leaves empty queues with no deadlines, timers, or periodic queries", async () => {
    const s = setup();
    const tasks = Object.values(DELIVERY_QUEUES).map(queue => {
      const t = task(); return { queue, t, worker: s.coordinator.register(queue, t) };
    });
    await Promise.all(tasks.map(t => t.worker.ready));
    expect(vi.getTimerCount()).toBe(0);
    expect(s.coordinator.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_600_000);
    for (const { queue, t } of tasks) {
      expect(t.run).toHaveBeenCalledTimes(1);
      await s.enqueue(queue); await s.enqueue(queue);
    }
    await vi.advanceTimersByTimeAsync(1);
    for (const { t } of tasks) expect(t.run).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(idleWorkSnapshot().active).toBe(0);
  });
  it("preserves a future deadline when the clock advances between scheduling reads", async () => {
    const s = setup(), t = task();
    let now = Date.now();
    const due = now + 1000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now++);
    try {
      await s.coordinator.register(DELIVERY_QUEUES.chatGitHubPublications, { ...t, nextRunAt: () => due }).ready;
      expect(s.coordinator.nextWakeAt()).toBe(due);
      expect(t.run).toHaveBeenCalledTimes(1);
      expect(s.onError).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
  it("schedules maintenance without holding idle intent, and lets new work preempt it", async () => {
    const s = setup(), t = task();
    let next: number | null = Date.now() + 60_000;
    await s.coordinator.register(DELIVERY_QUEUES.email, { ...t, nextRunAt: () => next }).ready;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(t.run).toHaveBeenCalledTimes(1);
    await s.enqueue(DELIVERY_QUEUES.email);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.run).toHaveBeenCalledTimes(2);
    expect(idleWorkSnapshot().active).toBe(0);
    next = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.run).toHaveBeenCalledTimes(3);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });
  it("does not postpone an already committed wake when another producer starts writing", async () => {
    const s = setup(), t = task();
    await s.coordinator.register(DELIVERY_QUEUES.feedback, t).ready;
    await s.enqueue();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const writing = s.owner.transaction(async tx => {
      await notifyDeliveryWork(tx, DELIVERY_QUEUES.feedback);
      await gate;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(t.run).toHaveBeenCalledTimes(2);
    release(); await writing;
    await vi.advanceTimersByTimeAsync(1);
    expect(t.run).toHaveBeenCalledTimes(3);
    expect(idleWorkSnapshot().active).toBe(0);
  });
  it.each([false, true])("pauses passive maintenance through a slow owned backup while preserving new work (%s)", async newWork => {
    const s = setup(), t = task();
    s.canRun.mockImplementation(() => !isIdleTaskDrainActive());
    s.canReconcile.mockReturnValue(true);
    await s.coordinator.register(DELIVERY_QUEUES.connection, {
      ...t, nextRunAt: () => Date.now() + 5000, pausePassiveMaintenance: true,
    }).ready;
    const drain = startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
    const getStatus = () => {
      const current = readTaskDrain(new Date());
      return { ...current, draining: current !== null, startedAt: current?.startedAt ?? null,
        expiresAt: current?.expiresAt ?? null, activeRuns: 0, pendingWakes: 0 };
    };
    const db = { transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ execute: async () => [{ blocked: false }] }) } as unknown as Db;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const checkpoint = async () => {
      const finish = beginIdleTrackedWork(); entered();
      try { await new Promise(resolve => setTimeout(resolve, 6000)); return true; }
      finally { finish(); }
    };
    expect(idleWorkSnapshot().active).toBe(0);
    const scan = readIdleSleepSafety(db, getStatus, Date.now, drain.ownerId, async () => "none", undefined, checkpoint);
    await Promise.race([started, scan.then(result => { throw new Error(`Backup did not start: ${JSON.stringify(result)}`); })]);
    expect(idleWorkSnapshot().active).toBe(1);
    if (newWork) await s.enqueue(DELIVERY_QUEUES.connection);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await scan).toEqual({ version: 1, backgroundWork: newWork ? "unknown" : "none" });
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(t.hasPending).toHaveBeenCalledTimes(newWork ? 2 : 1);
    expect(idleWorkSnapshot().active).toBe(0);
    stopTaskDrain();
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.run).toHaveBeenCalledTimes(2);
    expect(s.onError).not.toHaveBeenCalled();
  });
  it("fences unresolved writes until the server settles, then scans and releases the idle hold", async () => {
    const s = setup(), t = task();
    await s.coordinator.register(DELIVERY_QUEUES.feedback, t).ready;
    s.failCommit();
    await expect(s.enqueue()).rejects.toThrow("lost commit reply");
    expect(idleWorkSnapshot().active).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.run).toHaveBeenCalledTimes(2); // Empty scan cannot clear unresolved write.
    expect(idleWorkSnapshot().active).toBe(1);
    expect(s.coordinator.nextWakeAt()).not.toBeNull();
    s.settle();
    await vi.advanceTimersByTimeAsync(5001);
    expect(t.run.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(idleWorkSnapshot().active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retains unresolved intent across coordinator replacement", async () => {
    const s = setup(), t = task();
    await s.coordinator.register(DELIVERY_QUEUES.feedback, t).ready;
    s.failCommit(); await expect(s.enqueue()).rejects.toThrow();
    await s.coordinator.stop();
    expect(idleWorkSnapshot().active).toBe(0);
    const replacement = createDeliveryWorkCoordinator({ owner: s.owner, canRun: () => true, onError: vi.fn() });
    coordinators.push(replacement);
    await replacement.register(DELIVERY_QUEUES.feedback, t).ready;
    expect(idleWorkSnapshot().active).toBe(1);
    s.settle(); await vi.advanceTimersByTimeAsync(5001);
    expect(idleWorkSnapshot().active).toBe(0);
    expect(replacement.nextWakeAt()).toBeNull();
  });
  it("retries pending deliveries and transient failures, then goes quiet", async () => {
    const s = setup(), t = task();
    t.run.mockRejectedValueOnce(new Error("database disconnected"));
    t.hasPending.mockResolvedValueOnce(true);
    await s.coordinator.register(DELIVERY_QUEUES.feedback, t).ready;
    expect(s.onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.run).toHaveBeenCalledTimes(3);
    expect(s.coordinator.nextWakeAt()).toBeNull();
    expect(idleWorkSnapshot().active).toBe(0);
  });
  it("does not overlap a sweep or lose a commit during its final pending check", async () => {
    const s = setup(), t = task();
    let release!: (pending: boolean) => void;
    t.hasPending.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    s.coordinator.register(DELIVERY_QUEUES.connection, t);
    await vi.advanceTimersByTimeAsync(1);
    await s.enqueue(DELIVERY_QUEUES.connection);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.run).toHaveBeenCalledTimes(1);
    release(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.run).toHaveBeenCalledTimes(2);
  });
  it("reconciles a rollback during idle drain and releases the empty-queue hold without dispatching", async () => {
    const s = setup(), t = task();
    await s.coordinator.register(DELIVERY_QUEUES.feedback, t).ready;
    s.canRun.mockReturnValue(false);
    s.canReconcile.mockReturnValue(true);
    s.failCommit(); await expect(s.enqueue()).rejects.toThrow("lost commit reply");
    await vi.advanceTimersByTimeAsync(1);
    expect(idleWorkSnapshot().active).toBe(1);
    expect(t.run).toHaveBeenCalledTimes(1);
    s.settle("aborted");
    await vi.advanceTimersByTimeAsync(5001);
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(t.hasPending).toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(0);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });
  it("keeps committed pending work recoverable during drain without starting deliveries", async () => {
    const s = setup(), t = task();
    await s.coordinator.register(DELIVERY_QUEUES.feedback, t).ready;
    s.canRun.mockReturnValue(false);
    s.canReconcile.mockReturnValue(true);
    t.hasPending.mockResolvedValue(true);
    await s.enqueue();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(s.coordinator.nextWakeAt()).not.toBeNull();
    s.canRun.mockReturnValue(true);
    t.hasPending.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(5001);
    expect(t.run).toHaveBeenCalledTimes(2);
    expect(idleWorkSnapshot().active).toBe(0);
  });
  it("delivers already-admitted stop work during drain while respecting warm standby", async () => {
    const s = setup(), t = task();
    await s.coordinator.register(DELIVERY_QUEUES.budgetEnforcement, { ...t, runDuringDrain: true }).ready;
    s.canRun.mockReturnValue(false);
    s.canReconcile.mockReturnValue(true);
    await s.enqueue(DELIVERY_QUEUES.budgetEnforcement);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.run).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBeNull();
    s.canReconcile.mockReturnValue(false);
    await s.enqueue(DELIVERY_QUEUES.budgetEnforcement);
    await vi.advanceTimersByTimeAsync(5001);
    expect(t.run).toHaveBeenCalledTimes(2);
    s.canReconcile.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.run).toHaveBeenCalledTimes(3);
    expect(idleWorkSnapshot().active).toBe(0);
  });
  it("bounds an expired deadline retry during idle reconciliation and resumes after drain", async () => {
    const s = setup(), t = task();
    const due = Date.now() + 10_000;
    let next: number | null = due;
    const scheduled = { ...t, nextRunAt: () => next };
    await s.coordinator.register(DELIVERY_QUEUES.routineSchedules, scheduled).ready;
    s.canRun.mockReturnValue(false);
    s.canReconcile.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(10_020);
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(t.hasPending).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBe(due + t.retryMs);
    expect(idleWorkSnapshot().active).toBe(0);
    next = null;
    s.canRun.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(t.retryMs - 20);
    expect(t.run).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it("preserves a future deadline while reconciling a write during idle drain", async () => {
    const s = setup(), t = task();
    const due = Date.now() + 1000;
    let next: number | null = due;
    await s.coordinator.register(DELIVERY_QUEUES.routineSchedules, { ...t, nextRunAt: () => next }).ready;
    s.canRun.mockReturnValue(false);
    s.canReconcile.mockReturnValue(true);
    await s.enqueue(DELIVERY_QUEUES.routineSchedules);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.coordinator.nextWakeAt()).toBe(due);
    expect(t.run).toHaveBeenCalledTimes(1);
    next = null;
    s.canRun.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(t.run).toHaveBeenCalledTimes(2);
    expect(idleWorkSnapshot().active).toBe(0);
  });

  it("does not query during standby and resumes when admission opens", async () => {
    const s = setup(), t = task(); s.canRun.mockReturnValue(false);
    await s.coordinator.register(DELIVERY_QUEUES.toolAction, t).ready;
    await s.enqueue(DELIVERY_QUEUES.toolAction);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.run).not.toHaveBeenCalled();
    expect(t.hasPending).not.toHaveBeenCalled();
    s.canRun.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(5001);
    expect(t.run).toHaveBeenCalledTimes(1);
    expect(idleWorkSnapshot().active).toBe(0);
  });
  it("awaits in-flight work on shutdown and releases the subscription for restart", async () => {
    const s = setup(), t = task();
    let release!: () => void;
    t.run.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    s.coordinator.register(DELIVERY_QUEUES.chatCompletion, t);
    await vi.advanceTimersByTimeAsync(1);
    const stopped = vi.fn();
    const stopping = s.coordinator.stop().then(stopped);
    await s.enqueue(DELIVERY_QUEUES.chatCompletion);
    expect(stopped).not.toHaveBeenCalled();
    release(); await stopping;
    expect(vi.getTimerCount()).toBe(0);
    expect(idleWorkSnapshot().active).toBe(0);
  });
  it("cancels an abortable delivery before awaiting shutdown", async () => {
    const s = setup();
    const hasPending = vi.fn(async () => false);
    const run = vi.fn((signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    s.coordinator.register(DELIVERY_QUEUES.feedback, { retryMs: 5000, run, hasPending });
    await vi.advanceTimersByTimeAsync(1);
    await s.coordinator.stop();
    expect(run.mock.calls[0]?.[0].aborted).toBe(true);
    expect(hasPending).not.toHaveBeenCalled();
    expect(s.onError).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
