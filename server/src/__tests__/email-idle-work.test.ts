import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { emailChannelService } from "../services/email-channels.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const services: ReturnType<typeof emailChannelService>[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  vi.useRealTimers();
});
function fixture() {
  vi.useFakeTimers();
  const select = vi.fn(() => ({ from: () => ({ where: async () => [] }) }));
  const execute = vi.fn(async () => [{ xid: "42", status: "aborted" }]);
  const db = installDatabaseWorkSignals({ select, execute,
    async transaction(callback: (tx: any) => Promise<any>) {
      return callback({ execute, transaction: db.transaction });
    },
  });
  let enabled = true;
  const service = emailChannelService(db as unknown as Db, {
    heartbeat: { wakeup: vi.fn() },
    isBackgroundWorkEnabled: () => enabled,
    isReconciliationEnabled: () => true,
  });
  services.push(service);
  return { db, select, service, enable: (value: boolean) => { enabled = value; } };
}

describe("email idle work", () => {
  it("scans at startup, then leaves an unconfigured stack with zero timers and queries", async () => {
    const f = fixture();
    await f.service.start();
    expect(f.select).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("wakes on an outer transaction commit from a separate producer, never an inner savepoint", async () => {
    const f = fixture();
    await f.service.start();
    await f.db.transaction(async tx => {
      await tx.transaction(async (inner: object) => notifyDeliveryWork(inner, DELIVERY_QUEUES.email));
      expect(f.select).toHaveBeenCalledTimes(1);
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.select).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(idleWorkSnapshot().active).toBe(0);
  });
  it("retains startup and committed work across idle drain without SQL or dispatch", async () => {
    const f = fixture();
    f.enable(false);
    await f.service.start();
    await f.db.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.email));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.select).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(0);
    f.enable(true);
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retries a failed startup scan and unsubscribes on shutdown", async () => {
    const f = fixture();
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    f.select.mockImplementationOnce(() => { throw new Error("database unavailable"); });
    await f.service.start();
    await vi.advanceTimersByTimeAsync(1001);
    expect(f.select).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await f.service.shutdown();
    await f.db.transaction(tx => notifyDeliveryWork(tx, DELIVERY_QUEUES.email));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.select).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    warning.mockRestore();
  });
});
