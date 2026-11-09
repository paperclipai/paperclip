import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerDatabaseBackupWork } from "../services/database-backup-work.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
afterEach(async () => {
  for (const coordinator of coordinators.splice(0)) await coordinator.stop();
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  const execute = vi.fn(async () => []);
  const owner = installDatabaseWorkSignals({ execute, transaction: vi.fn() });
  const canRun = vi.fn(() => true), canReconcile = vi.fn(() => true), onError = vi.fn();
  const coordinator = createDeliveryWorkCoordinator({ owner, canRun, canReconcile, onError });
  coordinators.push(coordinator);
  const run = vi.fn(async (): Promise<unknown> => ({}));
  return { coordinator, execute, canRun, canReconcile, onError, run };
}
const intervalMs = 60_000;

describe("automatic database backup scheduling", () => {
  it("waits for the actual backup deadline without querying or holding idle work", async () => {
    const s = setup(), now = Date.now();
    const worker = registerDatabaseBackupWork(s.coordinator, { intervalMs, run: s.run });
    await worker.ready;
    expect(s.coordinator.nextWakeAt()).toBe(now + intervalMs);
    await vi.advanceTimersByTimeAsync(intervalMs - 1);
    expect(s.run).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.run).toHaveBeenCalledOnce();
    expect(s.coordinator.nextWakeAt()).toBe(now + 2 * intervalMs);
    worker.wake();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.run).toHaveBeenCalledOnce();
    expect(s.execute).not.toHaveBeenCalled();
  });

  it.each(["drain", "standby"])("retains a due backup through %s without passive SQL", async mode => {
    const s = setup();
    const worker = registerDatabaseBackupWork(s.coordinator, { intervalMs, run: s.run });
    await worker.ready;
    s.canRun.mockReturnValue(false);
    s.canReconcile.mockReturnValue(mode === "drain");
    await vi.advanceTimersByTimeAsync(3 * intervalMs);
    expect(s.run).not.toHaveBeenCalled();
    expect(s.execute).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(0);
    s.canRun.mockReturnValue(true);
    s.canReconcile.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(s.run).toHaveBeenCalledOnce();
    expect(s.coordinator.nextWakeAt()).toBe(Date.now() + intervalMs);
  });

  it("startup while draining preserves the first due backup", async () => {
    const s = setup();
    s.canRun.mockReturnValue(false);
    await registerDatabaseBackupWork(s.coordinator, { intervalMs, run: s.run }).ready;
    await vi.advanceTimersByTimeAsync(2 * intervalMs);
    expect(s.run).not.toHaveBeenCalled();
    s.canRun.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(s.run).toHaveBeenCalledOnce();
    expect(s.execute).not.toHaveBeenCalled();
  });

  it("reports a failed attempt and retries at the next scheduled slot", async () => {
    const s = setup(), now = Date.now();
    s.run.mockRejectedValueOnce(new Error("backup storage unavailable"));
    await registerDatabaseBackupWork(s.coordinator, { intervalMs, run: s.run }).ready;
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(s.onError).toHaveBeenCalledOnce();
    expect(s.coordinator.nextWakeAt()).toBe(now + 2 * intervalMs);
    s.canRun.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(s.run).toHaveBeenCalledOnce();
    expect(s.execute).not.toHaveBeenCalled();
    s.canRun.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(s.run).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBe(now + 4 * intervalMs);
  });

  it("keeps the schedule after the backup owner skips an overlapping manual backup", async () => {
    const s = setup();
    s.run.mockResolvedValueOnce(null);
    await registerDatabaseBackupWork(s.coordinator, { intervalMs, run: s.run }).ready;
    await vi.advanceTimersByTimeAsync(2 * intervalMs);
    expect(s.run).toHaveBeenCalledTimes(2);
    expect(s.onError).not.toHaveBeenCalled();
  });

  it("coalesces wakes during a slow backup and skips missed slots", async () => {
    const s = setup(), now = Date.now();
    let finish!: () => void;
    s.run.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const worker = registerDatabaseBackupWork(s.coordinator, { intervalMs, run: s.run });
    await worker.ready;
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(idleWorkSnapshot().active).toBe(1);
    worker.wake(); worker.wake();
    await vi.advanceTimersByTimeAsync(2 * intervalMs + 100);
    expect(s.run).toHaveBeenCalledOnce();
    finish();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.run).toHaveBeenCalledOnce();
    expect(s.coordinator.nextWakeAt()).toBe(now + 4 * intervalMs);
    expect(idleWorkSnapshot().active).toBe(0);
    await vi.advanceTimersByTimeAsync(intervalMs - 101);
    expect(s.run).toHaveBeenCalledTimes(2);
  });

  it("shutdown waits for the active backup and cannot start another", async () => {
    const s = setup();
    let finish!: () => void;
    s.run.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const worker = registerDatabaseBackupWork(s.coordinator, { intervalMs, run: s.run });
    await worker.ready;
    await vi.advanceTimersByTimeAsync(intervalMs);
    let stopped = false;
    const stopping = s.coordinator.stop().then(() => { stopped = true; });
    worker.wake();
    await vi.advanceTimersByTimeAsync(3 * intervalMs);
    expect(stopped).toBe(false);
    expect(s.run).toHaveBeenCalledOnce();
    finish();
    await stopping;
    expect(s.coordinator.nextWakeAt()).toBeNull();
    expect(idleWorkSnapshot().active).toBe(0);
    await vi.advanceTimersByTimeAsync(3 * intervalMs);
    expect(s.run).toHaveBeenCalledOnce();
  });

  it("restart establishes a fresh interval without replaying historical slots", async () => {
    const s = setup();
    await registerDatabaseBackupWork(s.coordinator, { intervalMs, run: s.run }).ready;
    await vi.advanceTimersByTimeAsync(intervalMs / 2);
    await s.coordinator.stop();
    await vi.advanceTimersByTimeAsync(4 * intervalMs);
    const next = setup();
    const now = Date.now();
    await registerDatabaseBackupWork(next.coordinator, { intervalMs, run: next.run }).ready;
    expect(next.coordinator.nextWakeAt()).toBe(now + intervalMs);
    expect(next.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(next.run).toHaveBeenCalledOnce();
    expect(s.run).not.toHaveBeenCalled();
  });
});
