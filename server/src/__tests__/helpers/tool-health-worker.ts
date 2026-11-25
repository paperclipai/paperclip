import type { Db } from "@paperclipai/db";
import { expect, vi } from "vitest";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { connectionHealthSchedule } from "../../services/tool-access/catalog/health-schedule.js";
import { registerToolConnectionHealthWork } from "../../services/tool-connection-health-work.js";
import { idleWorkSnapshot } from "../../services/task-admission.js";

export async function startToolHealthWorker(db: Db, companyId: string, now = new Date(), probe?: Parameters<typeof connectionHealthSchedule>[1]) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"], shouldAdvanceTime: true });
  vi.setSystemTime(now);
  const errors: unknown[] = [];
  const checkHealth = vi.fn(probe ?? (async () => { throw new Error("Unexpected due health probe"); }));
  const schedule = connectionHealthSchedule(db, checkHealth);
  const coordinator = createDeliveryWorkCoordinator({
    owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error),
  });
  try {
    await registerToolConnectionHealthWork(coordinator, {
      load: (scope, connectionId, applicationId, signal) => schedule.load(scope ?? companyId, connectionId, applicationId, signal), check: schedule.check,
    }, () => true).ready;
  } catch (error) {
    await coordinator.stop();
    vi.useRealTimers();
    throw error;
  }
  return {
    checkHealth,
    async expectDeadline(expected: number | null) {
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
        expect(idleWorkSnapshot().active).toBe(0);
        expect(coordinator.nextWakeAt()).toBe(expected);
      }, { timeout: 5_000 });
      expect(errors).toEqual([]);
      if (!probe) expect(checkHealth).not.toHaveBeenCalled();
    },
    async expectQuiet() {
      const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction"), executes = vi.spyOn(db, "execute");
      try {
        await vi.advanceTimersByTimeAsync(120_000);
        expect(reads).not.toHaveBeenCalled();
        expect(writes).not.toHaveBeenCalled();
        expect(executes).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore(); writes.mockRestore(); executes.mockRestore();
      }
    },
    async stop() {
      try { await coordinator.stop(); } finally { vi.useRealTimers(); }
    },
  };
}
