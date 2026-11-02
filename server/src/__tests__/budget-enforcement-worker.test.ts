import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installDatabaseWorkSignals } from "../../../packages/db/src/work-signals.js";
import type { Db } from "@paperclipai/db";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../services/delivery-work-notifications.js";
import { publishLiveEvent } from "../services/live-events.js";
import { registerBudgetEnforcementWork, registerCostAccountingWork, wakeCostAccountingWork } from "../services/budget-enforcement-worker.js";

const work = vi.hoisted(() => ({
  deliver: vi.fn(), pending: vi.fn(), next: vi.fn(), reconcile: vi.fn(), accounting: vi.fn(),
}));
vi.mock("../services/budgets.js", () => ({
  deliverBudgetEnforcement: work.deliver,
  hasPendingBudgetEnforcement: work.pending,
  nextBudgetReconciliationAt: work.next,
  reconcileDueBudgetPolicies: work.reconcile,
}));
vi.mock("../services/run-cost-accounting.js", () => ({ readCostAccountingWork: work.accounting }));

const coordinators: ReturnType<typeof createDeliveryWorkCoordinator>[] = [];
const subscriptions: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  work.deliver.mockResolvedValue(undefined);
  work.pending.mockResolvedValue(false);
  work.next.mockResolvedValue(null);
  work.reconcile.mockResolvedValue({ nextCursor: null });
  work.accounting.mockResolvedValue({ pending: false, nextRunAt: null });
});
afterEach(async () => {
  for (const stop of subscriptions.splice(0)) stop();
  for (const c of coordinators.splice(0)) await c.stop();
  vi.useRealTimers();
});
function setup() {
  const execute = vi.fn(async () => [{ xid: "42", status: "committed" }]);
  const owner = installDatabaseWorkSignals({ execute, async transaction(callback: (tx: unknown) => Promise<unknown>) {
    return callback({ execute, transaction: owner.transaction });
  } });
  const onError = vi.fn();
  const coordinator = createDeliveryWorkCoordinator({ owner, canRun: () => true, onError });
  coordinators.push(coordinator);
  return { owner, db: owner as unknown as Db, coordinator, onError };
}

describe("budget accounting delivery", () => {
  it("recovers at startup, then leaves unchanged budget history completely quiet", async () => {
    const s = setup();
    await registerBudgetEnforcementWork(s.db, s.coordinator, {}).ready;
    expect(work.reconcile).toHaveBeenCalledWith(s.db, { startup: true });
    expect(work.deliver).toHaveBeenCalledOnce();
    expect(s.coordinator.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(work.pending).toHaveBeenCalledOnce();
    expect(work.reconcile).toHaveBeenCalledOnce();
    await s.owner.transaction(tx => notifyDeliveryWork(tx as object, DELIVERY_QUEUES.budgetEnforcement));
    await vi.advanceTimersByTimeAsync(1);
    expect(work.reconcile).toHaveBeenCalledOnce();
    expect(work.deliver).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it("recovers a concrete policy-window deadline without polling before it", async () => {
    const s = setup();
    const due = Date.now() + 60_000;
    work.next.mockResolvedValue(new Date(due));
    work.reconcile.mockImplementation(async () => {
      if (Date.now() >= due) work.next.mockResolvedValue(null);
      return { nextCursor: null };
    });
    await registerBudgetEnforcementWork(s.db, s.coordinator, {}).ready;
    await vi.advanceTimersByTimeAsync(59_999);
    expect(work.reconcile).toHaveBeenCalledOnce();
    expect(s.coordinator.nextWakeAt()).toBe(due);
    await vi.advanceTimersByTimeAsync(1);
    expect(work.reconcile).toHaveBeenCalledTimes(2);
    expect(work.reconcile).toHaveBeenLastCalledWith(s.db, { startup: false });
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it("retries interrupted delivery and disarms after acknowledgement", async () => {
    const s = setup();
    work.deliver.mockRejectedValueOnce(new Error("Provider stop unavailable"));
    await registerBudgetEnforcementWork(s.db, s.coordinator, {}).ready;
    expect(s.onError).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(work.deliver).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it("continues bounded startup pages without forgetting the cursor after notifications", async () => {
    const s = setup();
    work.reconcile.mockResolvedValueOnce({ nextCursor: "company:agent:scope" });
    await registerBudgetEnforcementWork(s.db, s.coordinator, {}).ready;
    expect(work.reconcile).toHaveBeenLastCalledWith(s.db, { startup: true });
    await s.owner.transaction(tx => notifyDeliveryWork(tx as object, DELIVERY_QUEUES.budgetEnforcement));
    await vi.advanceTimersByTimeAsync(1);
    expect(work.reconcile).toHaveBeenLastCalledWith(s.db, { startup: true, cursor: "company:agent:scope" });
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });

  it("waits on an interrupted-service deadline and wakes terminal accounting from committed events", async () => {
    const s = setup();
    const recover = vi.fn(async () => {});
    const due = Date.now() + 120_001;
    work.accounting.mockResolvedValue({ pending: false, nextRunAt: due });
    const worker = registerCostAccountingWork(s.db, s.coordinator, recover);
    subscriptions.push(worker.stop);
    await worker.ready;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recover).toHaveBeenCalledOnce();
    publishLiveEvent({ companyId: "company", type: "heartbeat.run.status", payload: { status: "succeeded" } });
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledTimes(2);
    work.accounting.mockResolvedValue({ pending: false, nextRunAt: null });
    await vi.advanceTimersByTimeAsync(due - Date.now());
    expect(recover).toHaveBeenCalledTimes(3);
    expect(s.coordinator.nextWakeAt()).toBeNull();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(work.accounting).toHaveBeenCalledTimes(3);
  });

  it("replays durable spool work after a pre-transaction failure and releases its local wake on stop", async () => {
    const s = setup();
    const recover = vi.fn(async () => {});
    const worker = registerCostAccountingWork(s.db, s.coordinator, recover);
    subscriptions.push(worker.stop);
    await worker.ready;
    wakeCostAccountingWork(s.db);
    wakeCostAccountingWork(s.db);
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledTimes(2);
    worker.stop();
    wakeCostAccountingWork(s.db);
    await vi.advanceTimersByTimeAsync(1);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(s.coordinator.nextWakeAt()).toBeNull();
  });
});
