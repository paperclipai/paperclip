import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { registerBrowserUseCleanup } from "../services/browser-use-work.js";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.stop();
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers();
  const execute = vi.fn(async () => [{ xid: "42", status: "committed" }]);
  const owner = installDatabaseWorkSignals({ execute, async transaction(callback: (tx: any) => Promise<any>) {
    return callback({ execute });
  } });
  const enabled = vi.fn(() => true), primary = vi.fn(() => true), onError = vi.fn();
  const coordinator = createDeliveryWorkCoordinator({
    owner, canRun: () => enabled() && primary(), canReconcile: primary, onError,
  });
  coordinators.push(coordinator);
  const service = { sweep: vi.fn(async () => {}), nextSweepAt: vi.fn(async (): Promise<number | null> => null) };
  const start = () => registerBrowserUseCleanup(coordinator, service, enabled);
  const commit = () => owner.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.browser));
  return { service, coordinator, start, commit, enabled, primary, onError };
}
describe("browser cleanup scheduling", () => {
  it("stays quiet after an empty startup, wakes on commit, and stops after the final session closes", async () => {
    const s = setup();
    await s.start().ready;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(s.service.sweep).toHaveBeenCalledTimes(1);
    expect(s.service.nextSweepAt).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const due = Date.now() + 15_000;
    s.service.nextSweepAt.mockResolvedValue(due);
    await s.commit();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.service.sweep).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBe(due);
    await vi.advanceTimersByTimeAsync(14_998);
    expect(s.service.sweep).toHaveBeenCalledTimes(2);
    s.service.nextSweepAt.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.service.sweep).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("restores a future lease/retry deadline at startup and lets a control commit preempt it", async () => {
    const s = setup();
    const due = Date.now() + 180_000;
    s.service.nextSweepAt.mockResolvedValue(due);
    await s.start().ready;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(s.service.sweep).toHaveBeenCalledTimes(1);
    await s.commit();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.service.sweep).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBe(due);
  });
  it("retries a failed scan and bounds already-due batches", async () => {
    const s = setup();
    s.service.sweep.mockRejectedValueOnce(new Error("database unavailable"));
    await s.start().ready;
    expect(s.onError).toHaveBeenCalledTimes(1);
    s.service.nextSweepAt.mockResolvedValue(Date.now() - 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.service.sweep).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBe(Date.now() + 1000);
    s.service.nextSweepAt.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does no session SQL during standby or drain and recovers a first commit after drain", async () => {
    const s = setup();
    s.primary.mockReturnValue(false);
    await s.start().ready;
    await vi.advanceTimersByTimeAsync(6000);
    expect(s.service.sweep).not.toHaveBeenCalled();
    expect(s.service.nextSweepAt).not.toHaveBeenCalled();
    s.primary.mockReturnValue(true);
    s.enabled.mockReturnValue(false);
    await s.commit();
    await vi.advanceTimersByTimeAsync(6000);
    expect(s.service.sweep).not.toHaveBeenCalled();
    expect(s.service.nextSweepAt).not.toHaveBeenCalled();
    s.enabled.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(s.service.sweep).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("waits for in-flight cleanup on shutdown without rearming its deadline", async () => {
    const s = setup();
    let finish!: () => void;
    s.service.sweep.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const worker = s.start();
    await vi.advanceTimersByTimeAsync(1);
    let stopped = false;
    const stop = s.coordinator.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stop;
    await worker.ready;
    expect(s.service.nextSweepAt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
