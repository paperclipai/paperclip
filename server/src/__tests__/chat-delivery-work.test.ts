import { afterEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { registerChatDeliveryWork } from "../services/chat-delivery-work.js";
import { notifyChatDeliveryWork, notifyChatPublicationWork } from "../services/chat-work-notifications.js";

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
  const coordinator = createDeliveryWorkCoordinator({ owner,
    canRun: () => enabled() && primary(), canReconcile: primary, onError,
  });
  coordinators.push(coordinator);
  const service = {
    processQueuedDeliveries: vi.fn(async () => {}),
    scheduleQueuedPublications: vi.fn(async () => {}),
    processPendingSlackFileUploadReceipts: vi.fn(async () => {}),
    nextInboundDeliveryAt: vi.fn(async (): Promise<number | null> => null),
    nextPublicationAt: vi.fn(async (): Promise<number | null> => null),
    nextSlackReceiptAt: vi.fn(async (): Promise<number | null> => null),
    onPublicationsSettled: vi.fn(),
  };
  const start = () => registerChatDeliveryWork(coordinator, service, enabled);
  return { owner, service, coordinator, start, enabled, primary, onError };
}

describe("chat delivery work", () => {
  it("does one startup pass and no further queue scans when empty", async () => {
    const s = setup();
    await s.start().ready;
    await vi.advanceTimersByTimeAsync(3_600_000);
    for (const run of [s.service.processQueuedDeliveries, s.service.scheduleQueuedPublications, s.service.processPendingSlackFileUploadReceipts]) expect(run).toHaveBeenCalledTimes(1);
    expect(s.coordinator.nextWakeAt()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("coalesces commits, wakes receipt recovery after publication changes, and refills freed slots", async () => {
    const s = setup();
    await s.start().ready;
    await s.owner.transaction(tx => notifyChatPublicationWork(tx));
    await s.owner.transaction(tx => notifyChatPublicationWork(tx));
    await vi.advanceTimersByTimeAsync(1);
    expect(s.service.scheduleQueuedPublications).toHaveBeenCalledTimes(2);
    expect(s.service.processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(2);
    expect(s.service.processQueuedDeliveries).toHaveBeenCalledTimes(1);
    s.service.onPublicationsSettled.mock.calls[0]![0]();
    await vi.advanceTimersByTimeAsync(1);
    expect(s.service.scheduleQueuedPublications).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("keeps lanes independent and retains commits received during a blocked drain", async () => {
    const s = setup();
    let release!: () => void;
    s.service.processQueuedDeliveries.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const worker = s.start();
    await vi.advanceTimersByTimeAsync(1);
    await s.owner.transaction(tx => notifyChatDeliveryWork(tx));
    await s.owner.transaction(tx => notifyChatPublicationWork(tx));
    await vi.advanceTimersByTimeAsync(1);
    expect(s.service.processQueuedDeliveries).toHaveBeenCalledTimes(1);
    expect(s.service.scheduleQueuedPublications).toHaveBeenCalledTimes(2);
    release();
    await worker.ready;
    await vi.advanceTimersByTimeAsync(1);
    expect(s.service.processQueuedDeliveries).toHaveBeenCalledTimes(2);
  });
  it("restores future retries and stops when the last retry finishes", async () => {
    const s = setup();
    const due = Date.now() + 60_000;
    s.service.nextPublicationAt.mockResolvedValue(due);
    await s.start().ready;
    expect(s.coordinator.nextWakeAt()).toBe(due);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(s.service.scheduleQueuedPublications).toHaveBeenCalledTimes(1);
    s.service.nextPublicationAt.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.service.scheduleQueuedPublications).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does no queue SQL while standby or drain defers a first commit", async () => {
    const s = setup();
    s.primary.mockReturnValue(false);
    await s.start().ready;
    await vi.advanceTimersByTimeAsync(2000);
    s.primary.mockReturnValue(true); s.enabled.mockReturnValue(false);
    await s.owner.transaction(tx => notifyChatDeliveryWork(tx));
    await vi.advanceTimersByTimeAsync(2000);
    expect(s.service.processQueuedDeliveries).not.toHaveBeenCalled();
    expect(s.service.nextInboundDeliveryAt).not.toHaveBeenCalled();
    s.enabled.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.service.processQueuedDeliveries).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("retries failed selection without losing its startup recovery", async () => {
    const s = setup();
    s.service.nextSlackReceiptAt.mockRejectedValueOnce(new Error("connection lost"));
    await s.start().ready;
    expect(s.onError).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.service.processPendingSlackFileUploadReceipts).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
